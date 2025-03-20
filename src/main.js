const {app, BrowserWindow, ipcMain} = require('electron');
const express = require('express');
const {exec} = require('child_process');
const axios = require('axios');
const {createProxyMiddleware} = require('http-proxy-middleware');
const cors = require('cors');
const ngrok = require('ngrok');
const path = require('path');
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));

require('dotenv').config();

// Variables de configuración
let basePath;
let scrcpyPath;
let ngrokTunnel = null;
const appExpress = express();
const proxyApp = express();

// Configuración de puertos
const PORT = process.env.APP_PORT || 3000;
const APPIUM_PORT = process.env.APPIUM_PORT || 4729;
const PROXY_PORT = process.env.PROXY_PORT || 8089;
const ACCOUNT_API = process.env.ACCOUNT_API;
let SECRET_TOKEN = process.env.PASSWORD || 'socialfarmy';
const NGROK_AUTH_TOKEN = process.env.NGROK_AUTH_TOKEN || '';

// Inicialización de paths después de que Electron esté listo
function initializePaths() {
    basePath = app.isPackaged
        ? path.join(process.resourcesPath, 'resources')
        : path.join(__dirname, 'resources');

    scrcpyPath = path.join(basePath, 'scrcpy', 'scrcpy.exe');
}

// Configuración de Ngrok
const startNgrok = async () => {
    try {
        ngrokTunnel = await ngrok.connect({
            addr: APPIUM_PORT,
            authtoken: NGROK_AUTH_TOKEN,
            region: 'eu'
        });
        console.log(`🌎 Ngrok tunnel establecido en: ${ngrokTunnel}`);
        return ngrokTunnel;
    } catch (error) {
        console.error('❌ Error al iniciar ngrok:', error);
        throw error;
    }
};

const stopNgrok = async () => {
    if (ngrokTunnel) {
        await ngrok.disconnect();
        await ngrok.kill();
        ngrokTunnel = null;
    }
};

// Configuración del servidor Express
function setupExpress() {
    appExpress.use(cors());
    appExpress.use(express.json());
    appExpress.use(express.static('public'));

    async function getDeviceInfo(deviceId) {
        try {
            // Obtener información básica del dispositivo
            const [model, version, apps] = await Promise.all([
                getDeviceProperty(deviceId, 'ro.product.model'),
                getDeviceProperty(deviceId, 'ro.build.version.release'),
                getInstalledApps(deviceId)
            ]);

            return {
                id: deviceId,
                status: 'connected',
                port: APPIUM_PORT,
                model: model || 'Desconocido',
                android_version: version || 'N/A',
                apps: apps || [],
                apps_count: apps?.length || 0
            };
        } catch (error) {
            console.error(`Error obteniendo info del dispositivo ${deviceId}:`, error);
            return {
                id: deviceId,
                error: error.message
            };
        }
    }

    async function getDeviceProperty(deviceId, prop) {
        return new Promise((resolve) => {
            exec(`adb -s ${deviceId} shell getprop ${prop}`, (error, stdout) => {
                resolve(error ? null : stdout.toString().trim());
            });
        });
    }

    async function getInstalledApps(deviceId) {
        return new Promise((resolve) => {
            exec(`adb -s ${deviceId} shell pm list packages -3`, // -3 para mostrar solo apps de usuario
                (error, stdout) => {
                    if (error) {
                        console.error(`Error apps en ${deviceId}:`, error);
                        return resolve(null);
                    }
                    const apps = stdout.toString()
                        .split('\n')
                        .filter(p => p)
                        .map(p => p.replace('package:', '').trim());
                    resolve(apps);
                });
        });
    }

    async function getDevices() {
        exec('adb devices', (error, stdout) => {
            if (error) {
                return res.status(500).json({
                    success: false,
                    error: `Error ADB: ${error.message}`
                });
            }

            try {
                const devicesList = stdout.split('\n')
                    .slice(1)
                    .filter(line => line.trim())
                    .map(line => line.split('\t')[0]);

                Promise.all(devicesList.map(getDeviceInfo))
                    .then(devices => {
                        res.json({
                            success: true,
                            devices: devices.map(device => ({
                                ...device,
                                apps_count: device.apps?.length || 0
                            }))
                        });
                    })
                    .catch(error => {
                        console.error('Error general:', error);
                        res.status(500).json({
                            success: false,
                            error: 'Error obteniendo información de dispositivos'
                        });
                    });

            } catch (parseError) {
                res.status(500).json({
                    success: false,
                    error: `Error procesando dispositivos: ${parseError.message}`
                });
            }
        });
    }

    appExpress.get('/', (req, res) => {
        res.sendFile(path.join(__dirname, 'public', 'index.html'));
    });

    appExpress.get('/status/:port', (req, res) => {
        const {port} = req.params;
        exec(`curl -s http://localhost:${port}/status`, (error, stdout) => {
            if (error) return res.json({success: false, connected: false});
            res.json({success: true, connected: true});
        });
    });

    appExpress.get('/config', (req, res) => {
        res.json({
            success: true,
            url: ngrokTunnel,
            appium_port:
            APPIUM_PORT,
            port: PORT,
            proxy_port: PROXY_PORT,
            accountAPI: ACCOUNT_API
        });
    });

    appExpress.get('/ping', (req, res) => {
        res.json({success: true});
    });

    appExpress.get('/devices', (req, res) => {
        exec('adb devices', (error, stdout) => {
            if (error) {
                return res.status(500).json({
                    success: false,
                    error: `Error ADB: ${error.message}`
                });
            }

            try {
                const devicesList = stdout.split('\n')
                    .slice(1)
                    .filter(line => line.trim())
                    .map(line => line.split('\t')[0]);

                Promise.all(devicesList.map(getDeviceInfo))
                    .then(devices => {
                        axios.post('https://api.socialfarmy.com/api/ping/devices', {
                            devices: devices.map(device => ({
                                id: device.id,
                                model: device.model,
                                android_version: device.android_version,
                                apps: device.apps
                            }))
                        });

                        res.json({
                            success: true,
                            devices: devices.map(device => ({
                                ...device,
                                apps_count: device.apps?.length || 0
                            }))
                        });
                    })
                    .catch(error => {
                        console.error('Error general:', error);
                        res.status(500).json({
                            success: false,
                            error: 'Error obteniendo información de dispositivos'
                        });
                    });

            } catch (parseError) {
                res.status(500).json({
                    success: false,
                    error: `Error procesando dispositivos: ${parseError.message}`
                });
            }
        });
    });

    appExpress.get('/view/:deviceId', (req, res) => {
        const {deviceId} = req.params;
        exec(`"${scrcpyPath}" -s ${deviceId}`, (error) => {
            if (error) return res.status(500).json({success: false, error: error.message});
            res.json({success: true});
        });
    });

    appExpress.post('/connect', async (req, res) => {
        try {
            const {accountAPI, devices} = req.body;

            const response = await axios.post('https://api.socialfarmy.com/api/connect', {
                accountAPI,
                port: APPIUM_PORT,
                ngrokTunnel,
                devices
            });

            const data = await response.data;

            if (data.status === 'success') {
                exec(`start cmd /k appium -p ${APPIUM_PORT} --allow-insecure=adb_shell --relaxed-security`, (error) => {
                    if (error) throw new Error(error.message);
                });

                return res.json({
                    success: true,
                    message: `Appium iniciado en puerto ${APPIUM_PORT}`,
                    ngrokTunnel
                });
            }

            throw new Error(data.message || 'Error desconocido del servidor');

        } catch (error) {
            console.error('Error:', error);
            res.status(500).json({
                success: false,
                error: error.message,
                details: error.stack
            });
        }
    });

    // Configuración del proxy
    proxyApp.use((req, res, next) => {
        const token = req.headers['authorization'];
        if (!token || token !== `Bearer ${SECRET_TOKEN}`) {
            return res.status(403).json({error: 'Acceso no autorizado'});
        }
        next();
    });

    proxyApp.use('/', createProxyMiddleware({
        target: `http://localhost:${APPIUM_PORT}`,
        changeOrigin: true,
        logLevel: 'debug',
        onError: (err, req, res) => {
            console.error('Proxy error:', err);
            res.status(500).json({error: 'Error interno del proxy'});
        }
    }));
}

// Inicialización de servidores
function initServers() {
    appExpress.listen(PORT, () => {
        console.log(`🚀 Servidor principal en http://localhost:${PORT}`);
    });

    proxyApp.listen(PROXY_PORT, () => {
        console.log(`🔒 Proxy seguro en http://localhost:${PROXY_PORT}`);
    });
}

// Configuración de Electron
function createWindow() {
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

    // Filtrar mensajes de error de consola
    win.webContents.on('console-message', (event, level, message, line, sourceId) => {
        if (message.includes('display_layout.cc')) return;
        console.log(`Nivel ${level}: ${message}`);
    });

    win.loadURL(`http://localhost:${PORT}`);

    if (!app.isPackaged) {
        win.webContents.openDevTools();
    }
}

// Ciclo de vida de la aplicación
app.whenReady().then(() => {
    initializePaths();
    startNgrok();
    setupExpress();
    initServers();
    createWindow();
});


app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        stopNgrok();
        app.quit();
    }
});

app.on('before-quit', async () => {
    await stopNgrok();
});