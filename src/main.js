const { app, BrowserWindow } = require('electron');
const express = require('express');
const { exec: rawExec } = require('child_process');
const { promisify } = require('util');
const axios = require('axios');
const { createProxyMiddleware } = require('http-proxy-middleware');
const cors = require('cors');
const path = require('path');
require('dotenv').config();

// Promisify exec para usar async/await
const exec = promisify(rawExec);

// Configuración
const CONFIG = {
    PORTS: {
        APP: process.env.APP_PORT || 3000,
        APPIUM: process.env.APPIUM_PORT || 4729,
        PROXY: process.env.PROXY_PORT || 8089
    },
    PATHS: {
        SCRCPY: 'scrcpy/scrcpy.exe',
        CLOUDFLARED: 'cloudflared/bin/cloudflared.exe',
        PLATFORM_TOOLS: 'platform-tools'
    },
    API: {
        ACCOUNT: process.env.ACCOUNT_API,
        BASE_URL: 'https://api.socialfarmy.com/api'
    },
    SECURITY: {
        TOKEN: process.env.PASSWORD || 'socialfarmy'
    }
};

class PathManager {
    static initialize() {
        const basePath = app.isPackaged ?
            path.join(process.resourcesPath, 'resources') :
            path.join(__dirname, 'resources');

        return {
            scrcpy: path.join(basePath, CONFIG.PATHS.SCRCPY),
            cloudflared: path.join(basePath, CONFIG.PATHS.CLOUDFLARED),
            platformTools: path.join(basePath, CONFIG.PATHS.PLATFORM_TOOLS)
        };
    }
}

class TunnelService {
    static async createCloudflareTunnel(cloudflaredPath) {
        return new Promise((resolve, reject) => {
            const tunnelProcess = rawExec(
                `${cloudflaredPath} tunnel --url http://localhost:${CONFIG.PORTS.APPIUM}`
            );

            const errorHandler = (data) => {
                const match = data.match(/https:\/\/[a-zA-Z0-9.-]+\.trycloudflare\.com/);
                if (match) {
                    tunnelProcess.stderr.removeListener('data', errorHandler);
                    resolve(match[0]);
                }
            };

            tunnelProcess.stderr.on('data', errorHandler);
            tunnelProcess.on('close', (code) =>
                reject(`Tunnel closed with code ${code}`)
            );
        });
    }
}

class DeviceService {
    paths = PathManager.initialize();
    static async listDevices() {
        const paths = PathManager.initialize();
        const { stdout } = await exec(paths.platformTools+'\\adb.exe devices');
        return stdout
            .split('\n')
            .slice(1)
            .filter(line => line.trim())
            .map(line => line.split('\t')[0]);
    }

    static async getDeviceInfo(deviceId) {
        try {
            const [model, version, apps] = await Promise.all([
                DeviceService.getDeviceProperty(deviceId, 'ro.product.model'),
                DeviceService.getDeviceProperty(deviceId, 'ro.build.version.release'),
                DeviceService.getInstalledApps(deviceId)
            ]);

            return {
                id: deviceId,
                status: 'connected',
                port: CONFIG.PORTS.APPIUM,
                model: model || 'Unknown',
                android_version: version || 'N/A',
                apps: apps || [],
                apps_count: apps?.length || 0
            };
        } catch (error) {
            console.error(`Error getting device info for ${deviceId}:`, error);
            return { id: deviceId, error: error.message };
        }
    }

    static async getDeviceProperty(deviceId, prop) {
        const paths = PathManager.initialize();
        const { stdout } = await exec(`${paths.platformTools}\\adb.exe -s ${deviceId} shell getprop ${prop}`);
        return stdout.trim();
    }

    static async getInstalledApps(deviceId) {
        const paths = PathManager.initialize();
        try {
            const { stdout } = await exec(
                `${paths.platformTools}\\adb.exe -s ${deviceId} shell pm list packages -3`
            );
            return stdout
                .split('\n')
                .filter(p => p)
                .map(p => p.replace('package:', '').trim());
        } catch (error) {
            console.error(`Error getting apps for ${deviceId}:`, error);
            return [];
        }
    }
}

class ServerManager {
    constructor() {
        this.disallowedPorts = new Set([CONFIG.PORTS.APP, CONFIG.PORTS.PROXY]);

        this.appExpress = express();
        this.proxyApp = express();
        this.initializeServers();
    }

    initializeServers() {
        this.setupExpress();
        this.setupProxy();
        this.startServers();
    }

    setupExpress() {
        this.appExpress
            .use(cors())
            .use(express.json())
            .use(express.static('public'))
            .get('/', this.serveIndex)
            .get('/status/:port', this.handlePortStatus)
            .get('/config', this.getConfig)
            .get('/ping', this.ping)
            .get('/devices', this.handleDevices)
            .get('/view/:deviceId', this.handleDeviceView)
            .post('/connect', this.handleConnect)
            .use(this.errorHandler);
    }

    setupProxy() {
        this.proxyApp
            .use(this.authMiddleware)
            .use('/', createProxyMiddleware({
                target: `http://localhost:${CONFIG.PORTS.APPIUM}`,
                changeOrigin: true,
                logLevel: 'debug',
                onError: this.proxyErrorHandler
            }));
    }

    startServers() {
        this.appExpress.listen(CONFIG.PORTS.APP, () =>
            console.log(`🚀 Main server: http://localhost:${CONFIG.PORTS.APP}`)
        );

        this.proxyApp.listen(CONFIG.PORTS.PROXY, () =>
            console.log(`🔒 Proxy server: http://localhost:${CONFIG.PORTS.PROXY}`)
        );
    }


    serveIndex = (req, res) =>
        res.sendFile(path.join(__dirname, 'public', 'index.html'));

    handlePortStatus = async (req, res) => {
        try {
            const { port } = req.params;

            if (this.disallowedPorts.has(parseInt(port))) {
                return res.status(400).json({ error: 'Port checking not allowed' });
            }

            await axios.get(`http://localhost:${port}/status`, {
                timeout: 2000
            });
            res.json({ success: true, connected: true });
        } catch (error) {
            res.json({ success: false, connected: false });
        }
    };

    getConfig = (req, res) =>
        res.json({
            success: true,
            url: this.ngrokTunnel,
            appium_port: CONFIG.PORTS.APPIUM,
            ...CONFIG.PORTS,
            accountAPI: CONFIG.API.ACCOUNT
        });

    ping = (req, res) => res.json({ success: true });

    handleDevices = async (req, res) => {
        try {
            const devices = await DeviceService.listDevices();
            const devicesInfo = await Promise.all(devices.map(DeviceService.getDeviceInfo));

            await axios.post(`${CONFIG.API.BASE_URL}/ping/devices`, {
                devices: devicesInfo.map(({ id, model, android_version, apps }) =>
                    ({ id, model, android_version, apps }))
            });

            res.json({
                success: true,
                devices: devicesInfo.map(d => ({
                    ...d,
                    apps_count: d.apps?.length || 0
                }))
            });
        } catch (error) {
            console.error('Device error:', error);
            res.status(500).json({
                success: false,
                error: 'Error fetching devices'
            });
        }
    };

    handleDeviceView = async (req, res) => {
        try {
            const { deviceId } = req.params;
            await exec(`"${this.paths.scrcpy}" -s ${deviceId}`);
            res.json({ success: true });
        } catch (error) {
            res.status(500).json({
                success: false,
                error: error.message
            });
        }
    };

    handleConnect = async (req, res) => {
        try {
            const { data } = await axios.post(`${CONFIG.API.BASE_URL}/connect`, {
                ...req.body,
                port: CONFIG.PORTS.APPIUM,
                ngrokTunnel: this.ngrokTunnel
            });

            if (data.status !== 'success') {
                throw new Error(data.message || 'Server error');
            }

            await exec(
                `start cmd /k appium -p ${CONFIG.PORTS.APPIUM} ` +
                '--allow-insecure=adb_shell --relaxed-security --default-command-timeout 600 --command-timeout 600'
            );

            res.json({
                success: true,
                message: `Appium running on port ${CONFIG.PORTS.APPIUM}`,
                ngrokTunnel: this.ngrokTunnel
            });
        } catch (error) {
            console.error('Connection error:', error);
            res.status(500).json({
                success: false,
                error: error.message
            });
        }
    };

    authMiddleware = (req, res, next) => {
        const token = req.headers.authorization;
        if (token !== `Bearer ${CONFIG.SECURITY.TOKEN}`) {
            return res.status(403).json({ error: 'Unauthorized' });
        }
        next();
    };

    errorHandler = (err, req, res, next) => {
        console.error('Server error:', err);
        res.status(500).json({ error: 'Internal server error' });
    };

    proxyErrorHandler = (err, req, res) => {
        console.error('Proxy error:', err);
        res.status(500).json({ error: 'Proxy error' });
    };
}

class AppWindow {
    static create() {
        const win = new BrowserWindow({
            width: 1280,
            height: 720,
            webPreferences: {
                nodeIntegration: true,
                contextIsolation: false
            },
            autoHideMenuBar: true,
            icon: path.join(__dirname, 'public', 'favicon.ico')
        });

        win.webContents.on('console-message', (event, level, message) => {
            if (
                message.includes('display_layout.cc') ||
                message.includes('PlacementList must be sorted')
            ) {
                return false;
            }

            console.log(`[Browser Console] ${message}`);
        });

        win.loadURL(`http://localhost:${CONFIG.PORTS.APP}`);

        if (!app.isPackaged) {
            win.webContents.openDevTools();
        }
    }
}

app.whenReady().then(async () => {
    const paths = PathManager.initialize();
    const server = new ServerManager();
    server.paths = paths;

    AppWindow.create();

    try {
        server.ngrokTunnel = await TunnelService.createCloudflareTunnel(paths.cloudflared);
        console.log(`🌐 Tunnel created: ${server.ngrokTunnel}`);
    } catch (error) {
        console.error('Tunnel error:', error);
    }
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});