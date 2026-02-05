
//const __filename = fileURLToPath(import.meta.url);
//const __dirname = path.dirname(__filename);

const fastify = require('fastify')({logger: true})
const path = require("path");
const exec = require('child_process').exec;
const fetch = require("node-fetch");
const fs = require("fs");
const fastifyStatic = require('@fastify/static')
const os = require('os');
const osUtils = require('os-utils');
const spawn = require('child_process').spawn;
const sqlite3 = require("sqlite3").verbose();
const ThumbstickController = require('./thumbstick-controller');

// Pi-specific modules - mock them on non-Pi systems
let measureCPU = null;
let trigger = null;
let thumbstickController = null;
const isRaspberryPi = os.platform() === 'linux' && (os.arch() === 'arm64' || os.arch() === 'arm');

if (isRaspberryPi) {
  try {
    const { measureCPU: rpiMeasureCPU } = require('rpi_measure_temp');
    measureCPU = rpiMeasureCPU;
    const Gpio = require('onoff').Gpio;
    trigger = new Gpio(14, 'low');
  } catch (e) {
    console.log('Pi-specific modules not available, running in dev mode');
  }
}

// Mock GPIO for non-Pi systems
if (!trigger) {
  let mockState = 0;
  trigger = {
    writeSync: (val) => { mockState = val; },
    readSync: () => mockState
  };
}

// Register WebSocket plugin (optional, only if available)
let websocketEnabled = false;
try {
  const fastifyWebsocket = require('@fastify/websocket');
  fastify.register(fastifyWebsocket);
  websocketEnabled = true;
  console.log('WebSocket support enabled');
} catch (e) {
  console.log('WebSocket plugin not available - thumbstick controls disabled:', e.message);
}

// init sqlite db
const dbFile = "./data/sqlite.db";
const exists = fs.existsSync(dbFile);
const db = new sqlite3.Database(dbFile);

// Create Table SQL
const createTableSql = `CREATE TABLE IF NOT EXISTS Favorites (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channelId TEXT NOT NULL,
  title TEXT NOT NULL,
  location TEXT NOT NULL,
  lng REAL NOT NULL,
  lat REAL NOT NULL,
  UNIQUE (channelId));`;

// if ./data/sqlite.db does not exist, create it
db.serialize(() => {
  if (!exists) {
    db.run(createTableSql);
    console.log("New table Dreams created!");
  } else {
    console.log('Database "Favorites" ready to go!');
  }
});

// helper function that prevents html/css/script malice
const cleanseString = function (string) {
  return string.replace(/</g, "&lt;").replace(/>/g, "&gt;");
};

// Setup our static files
fastify.register(fastifyStatic, {
  root: path.join(__dirname, "public"),
  prefix: "/", // optional: default '/'
});

// GET: Get the list of channels for given location
//      Also query the favorites table and mark any channels in the 
//      the list that are alo in favorites
fastify.get("/channels/:locationId", function (request, reply) {
  var locationId = request.params.locationId;
  // var url = `https://radio.garden/api/ara/content/page/${locationId}/channels`;
  var url = `https://radio.garden/api/ara/content/secure/page/${locationId}/channels`
  headers = {
  'Referer': 'https://radio.garden',
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0.0.0 Safari/537.36'
  }
  fetch(url, {headers: headers})
    .then((res) => res.json())
    .then((json) => {
      // Validate the response structure
      if (!json || !json.data || !json.data.content || !json.data.content[0] || !json.data.content[0].items) {
        console.log("Invalid response from radio.garden for locationId:", locationId, json);
        reply.code(502).send({ error: "Invalid response from radio.garden" });
        return;
      }

      let channelIds = [];
      json.data.content[0].items.forEach(function (item) {
        channelIds.push(item.page.url.split("/").splice(-1)[0]);
      });
      let dbRows = [];

      const sql = `
        SELECT channelId FROM Favorites
        WHERE
        channelId IN (${new Array(channelIds.length).fill('?').join(',')})`;

      db.all(sql, channelIds, (error, rows) => {
        if (error) {
          console.log("DB Select Failed");
          console.log(error);
        } else {
          // console.log(rows);
          let channelIdLookup = new Set();
          rows.forEach(function (row) { channelIdLookup.add(row.channelId)});

          json.data.content[0].items.forEach(function (item) {
            let channelId = item.page.url.split("/").splice(-1)[0]
            if (channelIdLookup.has(channelId)) {
              item.page.is_favorite = 1;
            } else {
              item.page.is_favorite = 0;
            }
          })
          reply.send(json);
        }
      });
    })
    .catch((error) => {
      console.log("Error fetching channels for locationId:", locationId, error);
      reply.code(502).send({ error: "Failed to fetch channels" });
    });
});

// POST: Add a channel to favorites
fastify.post("/addfavorite", function (request, reply) {
  console.log("addfavorite request body:", request.body);
  var data = request.body;

  // Validate required fields
  if (!data || !data.channelId || !data.title || !data.location) {
    console.log("Missing required fields in request body");
    reply.code(400).send({ message: "Missing required fields" });
    return;
  }

  var channelId = cleanseString(data.channelId);
  var title = cleanseString(data.title);
  var location = cleanseString(data.location);
  var lat = data.lat;
  var lng = data.lng;

  db.run(
    `INSERT INTO Favorites (channelId, title, location, lng, lat) VALUES (?, ?, ?, ?, ?)`,
    channelId,
    title,
    location,
    lng,
    lat,
    (error) => {
      if (error) {
        console.log(error);
        reply.code(500).send({ message: "error!" });
      } else {
        reply.send({ message: "success" });
      }
    }
  );

});

// GET: Get the list of favorite channels
fastify.get("/favorites", function (request, reply) {
  db.all("SELECT * from Favorites", (err, rows) => {
    reply.send(JSON.stringify(rows));
  });
});

// GET: Get the details for the favorite channel
fastify.get("/favorite/:channelId", function (request, reply) {
  db.all(
    "SELECT * from Favorites where channelId=?",
    request.params.channelId,
    (err, rows) => {
      reply.send(JSON.stringify(rows));
    }
  );
});

// DELETE: Delete channelId from favorites list
fastify.delete("/favorite/:channelId", function (request, reply) {
  db.run(
    `DELETE from Favorites where channelId=?`,
    request.params.channelId,
    (error) => {
      if (error) {
        reply.send({ message: "error!" });
      } else {
        reply.send({ message: "success" });
      }
    }
  );
});

// GET: Return HTTP 200 if the external URL is reachable else return 500
fastify.get("/checkOnline", function (request, reply) { 
  var url = `http://gstatic.com/generate_204`;
  fetch(url).then(res => {
      reply.code(res.status);
      reply.send();
    }).catch(error => {
      console.log("Fetch Error");
      console.log(error);
      reply.code(500);
      reply.send();
    });
});

// POST: Toggle the state of the GPIO pin for the relay
fastify.post("/displayToggle", function (request, reply) {
  trigger.writeSync(trigger.readSync() ^ 1);
  reply.send({ message: "success", displayState: trigger.readSync() ^ 1});
});

// POST: Set the GPIO pin for the relay to LOW
fastify.post("/displayOn", function (request, reply) {
  trigger.writeSync(0);
  reply.send({ message: "success", displayState: trigger.readSync() ^ 1});
});

// POST: Set the GPIO pin for the relay to HIGH
fastify.post("/displayOff", function (request, reply) {
  trigger.writeSync(1);
  reply.send({ message: "success", displayState: trigger.readSync() ^ 1});
});

// POST: Restart host
fastify.post("/restart", function (request, reply) {
  exec('/bin/sudo /sbin/shutdown -r now', function(error, stdout, stderr) {
    console.log(stdout);
    console.log(stderr);
  });
});

// POST: shutdown host
fastify.post("/shutdown", function (request, reply) {
  exec('/bin/sudo /sbin/shutdown now', function(error, stdout, stderr) {
    console.log(stdout);
    console.log(stderr);
  });
});

// GET: System Info
fastify.get("/systemInfo", function (request, reply) {
  const nets = os.networkInterfaces();
  const results = Object.create(null);
  const netInfo = Object.create(null);
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      const familyV4Value = typeof net.family === 'string' ? 'IPv4' : 4
      if (net.family === familyV4Value && !net.internal) {
        if (!netInfo[name]) {
           netInfo[name] = "";
        }
        netInfo[name] = net.address;
      }
    }
  }
  results['netInfo'] = netInfo
  // collect system info
  const sysInfo = Object.create(null);
  results['sysInfo'] = sysInfo
  sysInfo['CPU Load'] = osUtils.loadavg(1);

  (async () => {
    if (measureCPU) {
      const data = await measureCPU();
      sysInfo['CPU Temp'] = `${Math.round(data['celsius'])} &deg;C`;
    } else {
      sysInfo['CPU Temp'] = 'N/A (dev mode)';
    }
    reply.send(JSON.stringify(results));
  })();
});

// Helper function to resolve redirects and get final stream URL
async function resolveStreamUrl(url, maxRedirects = 5) {
  const headers = {
    'Referer': 'https://radio.garden',
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0.0.0 Safari/537.36'
  };

  let currentUrl = url;
  for (let i = 0; i < maxRedirects; i++) {
    const res = await fetch(currentUrl, { headers: headers, redirect: 'manual' });
    if (res.status === 301 || res.status === 302) {
      currentUrl = res.headers.get('location');
      console.log(`  Redirect ${i + 1}: -> ${currentUrl}`);
    } else if (res.status === 200) {
      return { url: currentUrl, response: res };
    } else {
      return { error: `Unexpected status ${res.status}`, status: res.status };
    }
  }
  return { url: currentUrl }; // Return last URL if max redirects reached
}

// GET: Proxy stream from radio.garden (needed because Cloudflare blocks direct browser requests)
fastify.get("/stream/:channelId", async function (request, reply) {
  var channelId = request.params.channelId;
  var url = `https://radio.garden/api/ara/content/listen/${channelId}/channel.mp3`;

  try {
    console.log(`Stream ${channelId}: resolving...`);
    const result = await resolveStreamUrl(url);

    if (result.error) {
      console.log(`Stream ${channelId} error: ${result.error}`);
      reply.code(result.status || 502).send({ error: 'Stream not available' });
      return;
    }

    const streamUrl = result.url;
    console.log(`Stream ${channelId}: final URL -> ${streamUrl}`);

    // Now fetch and proxy the actual stream
    const https = require('https');
    const http = require('http');
    const protocol = streamUrl.startsWith('https') ? https : http;

    reply.raw.writeHead(200, {
      'Content-Type': 'audio/mpeg',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Transfer-Encoding': 'chunked'
    });

    const proxyReq = protocol.get(streamUrl, (proxyRes) => {
      proxyRes.pipe(reply.raw);
    });

    proxyReq.on('error', (err) => {
      console.log("Stream proxy request error:", err.message);
      if (!reply.raw.headersSent) {
        reply.code(500).send({ error: 'Stream proxy failed' });
      }
    });

    request.raw.on('close', () => {
      proxyReq.destroy();
    });

    return reply;
  } catch (error) {
    console.log("Stream proxy error:", error);
    reply.code(500).send({ error: 'Stream proxy failed' });
  }
});

// WebSocket endpoint for thumbstick controls
// Store connected WebSocket clients
const wsClients = new Set();

fastify.register(async function (fastify) {
  if (!websocketEnabled) return;

  fastify.get('/ws/controls', { websocket: true }, (connection, req) => {
    console.log('WebSocket client connected for controls');
    const socket = connection.socket;
    wsClients.add(socket);

    socket.on('message', (message) => {
      // Handle any messages from client (e.g., configuration)
      try {
        const data = JSON.parse(message.toString());
        console.log('WebSocket received:', data);
      } catch (e) {
        // Ignore invalid messages
      }
    });

    socket.on('close', () => {
      console.log('WebSocket client disconnected');
      wsClients.delete(socket);
    });

    socket.on('error', (err) => {
      console.log('WebSocket error:', err.message);
      wsClients.delete(socket);
    });

    // Send initial state
    if (socket.readyState === 1) { // WebSocket.OPEN
      socket.send(JSON.stringify({ type: 'connected', isRaspberryPi: isRaspberryPi }));
    }
  });
});

// Broadcast message to all connected WebSocket clients
function broadcastToClients(message) {
  const data = JSON.stringify(message);
  wsClients.forEach((client) => {
    try {
      if (client.readyState === 1) { // OPEN
        client.send(data);
      }
    } catch (e) {
      console.log('Error broadcasting to client:', e.message);
    }
  });
}

// Initialize thumbstick controller on Pi
if (isRaspberryPi) {
  thumbstickController = new ThumbstickController();

  thumbstickController.init().then((success) => {
    if (success) {
      // Set up event handlers
      thumbstickController.on('leftClick', (data) => {
        broadcastToClients({ type: 'leftClick', ...data });
      });

      thumbstickController.on('rightClick', (data) => {
        broadcastToClients({ type: 'rightClick', ...data });
      });

      thumbstickController.on('zoom', (data) => {
        broadcastToClients({ type: 'zoom', ...data });
      });

      thumbstickController.on('pan', (data) => {
        broadcastToClients({ type: 'pan', ...data });
      });

      thumbstickController.on('navigate', (data) => {
        broadcastToClients({ type: 'navigate', ...data });
      });

      // Start polling
      thumbstickController.start();
    }
  });
}

// Cleanup on exit
process.on('SIGINT', () => {
  if (thumbstickController) {
    thumbstickController.cleanup();
  }
  process.exit();
});

process.on('SIGTERM', () => {
  if (thumbstickController) {
    thumbstickController.cleanup();
  }
  process.exit();
});

// Run the server and report out to the logs
fastify.listen({port: 8001, host: "0.0.0.0"}, (err, address) => {
  if (err) {
    fastify.log.error(err);
    process.exit(1);
  }
  console.log(`App is listening on ${address}`);
});
