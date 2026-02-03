/**
 * Thumbstick Controller for Raspberry Pi
 *
 * Hardware setup:
 * - MCP3008 ADC connected via SPI
 * - Left thumbstick: X on CH0, Y on CH1, Button on GPIO17
 * - Right thumbstick: X on CH2, Y on CH3, Button on GPIO27
 *
 * Wiring for MCP3008:
 * - VDD -> 3.3V
 * - VREF -> 3.3V
 * - AGND -> GND
 * - CLK -> GPIO11 (SCLK)
 * - DOUT -> GPIO9 (MISO)
 * - DIN -> GPIO10 (MOSI)
 * - CS -> GPIO8 (CE0)
 * - DGND -> GND
 *
 * Thumbstick connections to MCP3008:
 * - Left X -> CH0
 * - Left Y -> CH1
 * - Right X -> CH2
 * - Right Y -> CH3
 *
 * Thumbstick buttons (directly to GPIO):
 * - Left button -> GPIO17 (active low, use internal pullup)
 * - Right button -> GPIO27 (active low, use internal pullup)
 */

const EventEmitter = require('events');

class ThumbstickController extends EventEmitter {
  constructor(options = {}) {
    super();

    this.options = {
      // ADC channels for each axis
      leftXChannel: options.leftXChannel || 0,
      leftYChannel: options.leftYChannel || 1,
      rightXChannel: options.rightXChannel || 2,
      rightYChannel: options.rightYChannel || 3,
      // GPIO pins for buttons
      leftButtonPin: options.leftButtonPin || 17,
      rightButtonPin: options.rightButtonPin || 27,
      // Deadzone (0-1, percentage of center)
      deadzone: options.deadzone || 0.15,
      // Poll interval in ms
      pollInterval: options.pollInterval || 50,
      // Threshold for direction detection (0-1)
      threshold: options.threshold || 0.3,
    };

    this.adc = null;
    this.leftButton = null;
    this.rightButton = null;
    this.pollTimer = null;
    this.isRunning = false;

    // State tracking
    this.state = {
      left: { x: 0, y: 0, button: false, zoomMode: false },
      right: { x: 0, y: 0, button: false },
      lastDirection: { left: null, right: null }
    };

    // Debounce for button clicks
    this.lastLeftClick = 0;
    this.lastRightClick = 0;
    this.clickDebounce = 200; // ms
  }

  async init() {
    try {
      // Try to load Pi-specific modules
      const mcpSpiAdc = require('mcp-spi-adc');
      const Gpio = require('onoff').Gpio;

      // Initialize ADC channels
      this.channels = {
        leftX: mcpSpiAdc.open(this.options.leftXChannel, { speedHz: 1000000 }, (err) => {
          if (err) console.log('Error opening left X channel:', err);
        }),
        leftY: mcpSpiAdc.open(this.options.leftYChannel, { speedHz: 1000000 }, (err) => {
          if (err) console.log('Error opening left Y channel:', err);
        }),
        rightX: mcpSpiAdc.open(this.options.rightXChannel, { speedHz: 1000000 }, (err) => {
          if (err) console.log('Error opening right X channel:', err);
        }),
        rightY: mcpSpiAdc.open(this.options.rightYChannel, { speedHz: 1000000 }, (err) => {
          if (err) console.log('Error opening right Y channel:', err);
        }),
      };

      // Initialize button GPIOs with internal pullup (active low)
      this.leftButton = new Gpio(this.options.leftButtonPin, 'in', 'both', { debounceTimeout: 50 });
      this.rightButton = new Gpio(this.options.rightButtonPin, 'in', 'both', { debounceTimeout: 50 });

      // Set up button interrupts
      this.leftButton.watch((err, value) => {
        if (err) return;
        this.handleLeftButton(value === 0); // Active low
      });

      this.rightButton.watch((err, value) => {
        if (err) return;
        this.handleRightButton(value === 0); // Active low
      });

      console.log('Thumbstick controller initialized on Pi');
      return true;
    } catch (e) {
      console.log('Thumbstick controller: Pi modules not available, running in mock mode');
      return false;
    }
  }

  handleLeftButton(pressed) {
    const now = Date.now();
    if (pressed && (now - this.lastLeftClick) > this.clickDebounce) {
      this.lastLeftClick = now;
      // Toggle zoom mode
      this.state.left.zoomMode = !this.state.left.zoomMode;
      this.emit('leftClick', { zoomMode: this.state.left.zoomMode });
      console.log('Left stick clicked - Zoom mode:', this.state.left.zoomMode ? 'ON' : 'OFF');
    }
    this.state.left.button = pressed;
  }

  handleRightButton(pressed) {
    const now = Date.now();
    if (pressed && (now - this.lastRightClick) > this.clickDebounce) {
      this.lastRightClick = now;
      this.emit('rightClick', {});
      console.log('Right stick clicked - Play selected');
    }
    this.state.right.button = pressed;
  }

  readChannel(channel) {
    return new Promise((resolve, reject) => {
      if (!channel) {
        resolve(0.5); // Center value for mock mode
        return;
      }
      channel.read((err, reading) => {
        if (err) {
          reject(err);
        } else {
          // reading.value is 0-1, convert to -1 to 1
          resolve(reading.value);
        }
      });
    });
  }

  applyDeadzone(value) {
    // value is 0-1, center is 0.5
    const centered = (value - 0.5) * 2; // -1 to 1
    if (Math.abs(centered) < this.options.deadzone) {
      return 0;
    }
    // Scale remaining range
    const sign = centered > 0 ? 1 : -1;
    const scaled = (Math.abs(centered) - this.options.deadzone) / (1 - this.options.deadzone);
    return sign * scaled;
  }

  getDirection(x, y) {
    const threshold = this.options.threshold;

    if (Math.abs(x) < threshold && Math.abs(y) < threshold) {
      return null;
    }

    // Determine primary direction
    if (Math.abs(x) > Math.abs(y)) {
      return x > 0 ? 'right' : 'left';
    } else {
      return y > 0 ? 'down' : 'up';
    }
  }

  async poll() {
    if (!this.isRunning) return;

    try {
      // Read all channels
      const [leftXRaw, leftYRaw, rightXRaw, rightYRaw] = await Promise.all([
        this.readChannel(this.channels?.leftX),
        this.readChannel(this.channels?.leftY),
        this.readChannel(this.channels?.rightX),
        this.readChannel(this.channels?.rightY),
      ]);

      // Apply deadzone
      const leftX = this.applyDeadzone(leftXRaw);
      const leftY = this.applyDeadzone(leftYRaw);
      const rightX = this.applyDeadzone(rightXRaw);
      const rightY = this.applyDeadzone(rightYRaw);

      // Update state
      this.state.left.x = leftX;
      this.state.left.y = leftY;
      this.state.right.x = rightX;
      this.state.right.y = rightY;

      // Detect direction changes for left stick
      const leftDir = this.getDirection(leftX, leftY);
      if (leftDir !== this.state.lastDirection.left) {
        this.state.lastDirection.left = leftDir;
        if (leftDir) {
          if (this.state.left.zoomMode) {
            // In zoom mode, up/down controls zoom
            if (leftDir === 'up') {
              this.emit('zoom', { direction: 'in' });
            } else if (leftDir === 'down') {
              this.emit('zoom', { direction: 'out' });
            }
          } else {
            // Not in zoom mode, left stick does map pan
            this.emit('pan', { direction: leftDir });
          }
        }
      }

      // Detect direction changes for right stick (navigation)
      const rightDir = this.getDirection(rightX, rightY);
      if (rightDir !== this.state.lastDirection.right) {
        this.state.lastDirection.right = rightDir;
        if (rightDir) {
          this.emit('navigate', { direction: rightDir });
        }
      }

    } catch (e) {
      console.log('Thumbstick poll error:', e);
    }

    // Schedule next poll
    this.pollTimer = setTimeout(() => this.poll(), this.options.pollInterval);
  }

  start() {
    if (this.isRunning) return;
    this.isRunning = true;
    this.poll();
    console.log('Thumbstick controller started');
  }

  stop() {
    this.isRunning = false;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    console.log('Thumbstick controller stopped');
  }

  cleanup() {
    this.stop();

    // Close ADC channels
    if (this.channels) {
      Object.values(this.channels).forEach(ch => {
        if (ch && ch.close) ch.close();
      });
    }

    // Unexport GPIOs
    if (this.leftButton) this.leftButton.unexport();
    if (this.rightButton) this.rightButton.unexport();

    console.log('Thumbstick controller cleaned up');
  }

  getState() {
    return this.state;
  }
}

module.exports = ThumbstickController;
