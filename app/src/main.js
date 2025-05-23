// @ts-nocheck
// Initialize "close", "expand" and "minimize" buttons

const closeButton = document.querySelector('#close-btn');
const minimizeButton = document.querySelector('#min-btn');
const expandCollapseButton = document.querySelector('#expand-collapse-btn');
let expanded = false;

closeButton.onclick = () => {
  stopAudioAndMic();
  close();

  if (!assistantConfig['alwaysCloseToTray']) {
    quitApp();
  }
};

expandCollapseButton.onclick = () => toggleExpandWindow();

minimizeButton.onclick = () => {
  if (minimizeWindow !== undefined) {
    minimizeWindow();
  }
  else {
    // If `minimizeWindow` function is not available,
    // execute `assistantWindow.minimize()`.
    //
    // Note: This will cause the window to close right away
    // if float behavior is set to "Close on Blur"

    assistantWindow.minimize();
  }
};

// Library Imports

const electron = require('electron');
const GoogleAssistant = require('google-assistant');
const isValidAccelerator = require('electron-is-accelerator');
const googleIt = require('google-it');
const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

require('./auth/authHandler');
const { KeyBindingListener, getNativeKeyName } = require('./keybinding');
const { getHotwordDetectorInstance } = require('./hotword');
const supportedLanguages = require('./common/lang');
const themes = require('./common/themes');
const Microphone = require('./lib/microphone');
const AudioPlayer = require('./lib/audio_player');
const UpdaterRenderer = require('./updater/updaterRenderer');

const {
  UpdaterStatus,
  releasesUrl,
  getTagReleaseLink,
  getSupportedLinuxPackageFormat,
} = require('./updater/updaterUtils');

const {
  fallbackModeConfigKeys,
  isDebOrRpm,
  isSnap,
  isAppImage,
  isWaylandSession,
  getConfigFilePath,
  getFlagsFilePath,
  displayDialog,
  displayAsyncDialog,
  displayAsyncOpenDialog,
  repoUrl,
  minimizeWindow,
} = require('./common/utils');

// --- MODIFICACIÓN: Importar la nueva función de autenticación ---
const { startServerAuth } = require('./serverAuth');
// --- FIN MODIFICACIÓN ---

const { ipcRenderer } = electron;
const { app } = electron.remote;
const assistantWindow = electron.remote.getCurrentWindow();
const electronShell = electron.shell;
const assistantWindowLaunchArgs = ipcRenderer.sendSync('get-assistant-win-launch-args');

const parser = new DOMParser();
const audPlayer = new AudioPlayer();
let mic = new Microphone();

// Assistant config initialization

const userDataPath = ipcRenderer.sendSync('get-userdata-path');
const configFilePath = getConfigFilePath(userDataPath);
const flagsFilePath = getFlagsFilePath(userDataPath);
let assistantConfig = require('./common/initialConfig');
const flags = require('./common/initialFlags');

const history = [];
let historyHead = -1;
let queryHistoryHead = 0;
let currentTypedQuery = ''; // Query that the user is typing currently
const firstLaunch = electron.remote.getGlobal('firstLaunch');
let initScreenFlag = 1;
let isAssistantReady = false;
const assistantInput = document.querySelector('#assistant-input');
let assistantMicrophone = document.querySelector('#assistant-mic');
const suggestionArea = document.querySelector('#suggestion-area');
const mainArea = document.querySelector('#main-area');
let initHeadline;

// For Audio Visualization
// eslint-disable-next-line no-undef
const p5jsMic = new p5.AudioIn();

// Add click listener for "Settings" button
document.querySelector('#settings-btn').onclick = () => openConfig();

if (!firstLaunch) {
  ipcRenderer.send('update-did-launch-window');
}

// Notify the main process that first launch is completed
ipcRenderer.send('update-first-launch');

// Assuming as first-time user
let isFirstTimeUser = true;

// --- MODIFICACIÓN: Comprobar si ya está logueado (opcional, depende de cómo maneje serverAuth el estado) ---
// const isLoggedIn = localStorage.getItem('isLoggedIn') === 'true';
// console.log('Is logged in (from localStorage):', isLoggedIn);
// --- FIN MODIFICACIÓN ---

// Check Microphone Access
let canAccessMicrophone = true;

navigator.mediaDevices
  .getUserMedia({ audio: true })
  .then((rawStream) => rawStream.getTracks().forEach((track) => track.stop()))
  .catch((e) => {
    console.group(...consoleMessage('Microphone not accessible', 'warn'));
    console.error(e);
    console.groupEnd();

    canAccessMicrophone = false;
    displayQuickMessage('Microphone is not accessible');
  });

// Set Distribution Type for linux platform

getSupportedLinuxPackageFormat().then((distType) => {
  if (distType !== null) {
    process.env.DIST_TYPE = distType;
  }
});

// Set settings badge

if (sessionStorage.getItem('updaterStatus') === UpdaterStatus.UpdateDownloaded) {
  document.querySelector('#settings-btn')?.classList.add('active-badge');
}

// Load global flags

if (fs.existsSync(flagsFilePath)) {
  const savedFlags = JSON.parse(fs.readFileSync(flagsFilePath));
  Object.assign(flags, savedFlags);
}
else {
  flags.appVersion = getVersion();
  fs.writeFileSync(flagsFilePath, JSON.stringify(flags));
}

// Display a quick message stating the app was updated

if (!firstLaunch) {
  if (flags.appVersion !== getVersion()) {
    displayQuickMessage('App was updated successfully', true);

    flags.appVersion = getVersion();
    flags.displayPostUpdateBanner = true;

    fs.writeFileSync(flagsFilePath, JSON.stringify(flags));
    ipcRenderer.send('update-flags', flags);
  }
}

// Initialize Configuration
if (fs.existsSync(configFilePath)) {
  const savedConfig = JSON.parse(fs.readFileSync(configFilePath));

  if (isFallbackMode()) {
    const minimalConfig = Object.fromEntries(
      Object.entries(savedConfig)
        .filter(([configKey, _]) => fallbackModeConfigKeys.includes(configKey)),
    );

    Object.assign(assistantConfig, minimalConfig);

    console.group(...consoleMessage('[FALLBACK MODE] Only minimal config loaded', 'warn'));
    console.log(minimalConfig);
    console.groupEnd();
  }
  else {
    Object.assign(assistantConfig, savedConfig);
    console.log(...consoleMessage('Config loaded'));
  }

  isFirstTimeUser = false;
}
else {
  // Assuming as first-time user

  mainArea.innerHTML = `
    <div class="init">
      <center id="assistant-logo-main-parent">
        <img id="first-time-logo" src="../res/meet_google_assist.svg" alt="">
      </center>

      <div id="init-headline-parent">
        <div id="init-headline">
          Meet your Google Assistant!
        </div>
      </div>

      <div id="first-time-desc-parent">
        <div id="first-time-desc">
          Ask it questions. Tell it to do things. It’s your own personal Google, always ready to help.
        </div>
      </div>
    </div>
  `;

  suggestionArea.innerHTML = '<div class="suggestion-parent"></div>';
  const suggestionParent = document.querySelector('.suggestion-parent');

  suggestionParent.innerHTML = `
    <div id="get-started-btn" class="suggestion" onclick="showNextScreen()">
      <span>
        <img src="../res/proceed.svg" style="
          height: 19px;
          width: 16px;
          vertical-align: top;
          padding-right: 10px;
          ${getEffectiveTheme() === 'light' ? 'filter: invert(1);' : ''}"
        >
      </span>
      Get Started
    </div>
  `;

  suggestionParent.querySelector('#get-started-btn').onclick = () => {
    mainArea.innerHTML = `
      <div class="init">
        <center id="assistant-logo-main-parent">
          <img id="first-time-logo" src="../res/assistant_sdk_client.svg" alt="">
        </center>

        <div id="init-headline-parent">
          <div id="init-headline">
            Before you start...
          </div>
        </div>

        <div id="first-time-desc-parent">
          <div id="first-time-desc">
            This client is based on Google Assistant SDK. This means that it is limited in its capability and
            might not be working the same way the official client on phones and other devices work
          </div>
        </div>
      </div>
    `;

    suggestionArea.innerHTML = '<div class="suggestion-parent"></div>';

    // eslint-disable-next-line no-shadow
    const suggestionParent = document.querySelector('.suggestion-parent');

    suggestionParent.innerHTML = `
      <div id="proceed-btn" class="suggestion">
        <span>
          <img src="../res/proceed.svg" style="
            height: 19px;
            width: 16px;
            vertical-align: top;
            padding-right: 10px;
            ${getEffectiveTheme() === 'light' ? 'filter: invert(1);' : ''}"
          >
        </span>
        Proceed
      </div>
    `;

    // --- MODIFICACIÓN: Cambiar acción del botón Proceed ---
    suggestionArea.querySelector('#proceed-btn').onclick = () => {
      // Set assistant's language to system language
      const systemLanguage = navigator.language;

      if (Object.keys(supportedLanguages).includes(systemLanguage)) {
        assistantConfig.language = systemLanguage;
      }

      // Write the config (Puede que quieras mover esto a después de la autenticación exitosa)
      fs.writeFile(configFilePath, JSON.stringify(assistantConfig), () => {
        console.log('Config File was added to userData path');
      });

      // Iniciar el flujo de autenticación del servidor en lugar de relanzar
      console.log('First time user proceeding to server authentication...');
      startServerAuth();

      // Ya no relanzamos aquí directamente
      // relaunchAssistant();
    };
    // --- FIN MODIFICACIÓN ---
  };

  // If the user is opening the app for the first time,
  // throw `Exception` to prevent Assistant initialization until setup/login is done

  if (isFirstTimeUser) {
    // Disable settings button
    const settingsButton = document.querySelector('#settings-btn');
    settingsButton.remove();

    throw Error([
      'First Time User: Halting Assistant Initialization.',
      'Click through the welcome screens to proceed.',
    ].join(' '));
  }
}

// Setup Assistant Window

setTheme();
setAssistantWindowBorder();

if (assistantConfig['startAsMaximized']) {
  toggleExpandWindow();
}

if (assistantConfig['windowFloatBehavior'] === 'close-on-blur') {
  window.onblur = closeOnBlurCallback;
}

// Setup Hotword Detection

const hotwordDetector = getHotwordDetectorInstance((hotword) => {
  console.log(...consoleMessage(`Hotword Detected: "${hotword}"`));

  if (!assistantWindow.isVisible()) {
    relaunchAssistant({
      shouldStartMic: true,
    });
  }
  else {
    if (assistantWindow.isMinimized()) {
      assistantWindow.restore();
    }

    startMic();
  }
});

if (assistantConfig['respondToHotword']) {
  hotwordDetector.start();
}

// Set microphone and speaker source

(async () => {
  // Initialize p5.js source list for `setSource` to work
  await p5jsMic.getSources();

  const deviceList = await navigator.mediaDevices.enumerateDevices();
  const audioInDeviceIndex = deviceList
    .filter((device) => device.kind === 'audioinput')
    .map((device) => device.deviceId)
    .indexOf(assistantConfig.microphoneSource);

  const audioOutDeviceIndex = deviceList
    .filter((device) => device.kind === 'audiooutput')
    .map((device) => device.deviceId)
    .indexOf(assistantConfig.speakerSource);

  if (audioInDeviceIndex !== -1) {
    // If the audio-in Device ID exists
    mic.setDeviceId(assistantConfig.microphoneSource);
    hotwordDetector.setMicrophone(assistantConfig.microphoneSource);
    p5jsMic.setSource(audioInDeviceIndex);
  }

  if (audioOutDeviceIndex !== -1) {
    // If the audio-out Device ID exists
    audPlayer.setDeviceId(assistantConfig.speakerSource);
  }
})();

const updaterRenderer = new UpdaterRenderer({
  onUpdateAvailable: (info) => {
    const doesUseGenericUpdater = ipcRenderer.sendSync('update:doesUseGenericUpdater');

    // If auto-updates are disabled, notify the user
    // that a new update is available, else notify that
    // an update is being downloaded.

    if (!assistantConfig.autoDownloadUpdates || doesUseGenericUpdater || process.env.DEV_MODE) {
      displayQuickMessage('Update Available!');
    }
    else {
      displayQuickMessage('Downloading Update');
    }

    sessionStorage.setItem('updateVersion', info.version);

    // Set badge in the settings button to let the user know
    // that a new update is available (for deb, rpm, snap).

    const settingsButton = document.querySelector('#settings-btn');

    const displaySettingsBadge = (
      settingsButton && (
        !assistantConfig.autoDownloadUpdates
        || process.env.DEV_MODE
        || isDebOrRpm()
        || isSnap()
      )
    );

    if (displaySettingsBadge) {
      settingsButton.classList.add('active-badge');
    }
  },

  onUpdateDownloaded: () => {
    displayQuickMessage('Restart app to update');

    // Set badge in the settings button to let the user
    // that the update is ready to be installed.

    const settingsButton = document.querySelector('#settings-btn');

    if (settingsButton) {
      settingsButton.classList.add('active-badge');
    }
  },

  onUpdateApplied: () => {
    if (process.platform !== 'darwin') return;
    displayQuickMessage('Restart app to new version');
  },
});

updaterRenderer.autoDownloadUpdates = assistantConfig.autoDownloadUpdates;

const config = {
  auth: {
    // --- MODIFICACIÓN: Key file y tokens path podrían ser menos relevantes para el login inicial ---
    // La librería podría aún usarlos internamente o necesitar placeholders.
    // O, podría necesitar una configuración de auth completamente diferente para flujo de servidor.
    // Por ahora, los mantenemos pero la lógica de error inicial y showGetTokenScreen cambian.
    keyFilePath: assistantConfig['keyFilePath'],
    // where you want the tokens to be saved
    // will create the directory if not already there
    // Initial launch of the assistant will not trigger token saving
    savedTokensPath: !firstLaunch
      ? assistantConfig['savedTokensPath']
      : undefined,
    // --- FIN MODIFICACIÓN ---

    // --- MODIFICACIÓN: tokenInput ahora llama a la función que inicia el flujo del servidor ---
    tokenInput: showGetTokenScreen, // Esta función ahora llama a startServerAuth
    // --- FIN MODIFICACIÓN ---
  },
  // this param is optional, but all options will be shown
  conversation: {
    audio: {
      encodingIn: 'LINEAR16', // supported are LINEAR16 / FLAC (defaults to LINEAR16)
      sampleRateIn: 16000, // supported rates are between 16000-24000 (defaults to 16000)
      encodingOut: 'MP3', // supported are LINEAR16 / MP3 / OPUS_IN_OGG (defaults to LINEAR16)
      sampleRateOut: 24000, // supported are 16000 / 24000 (defaults to 24000)
    },
    lang: assistantConfig['language'], // language code for input/output (defaults to en-US)
    deviceModelId: '', // use if you've gone through the Device Registration process
    deviceId: '', // use if you've gone through the Device Registration process
    // textQuery: "", // if this is set, audio input is ignored
    isNew: assistantConfig['forceNewConversation'], // set this to true if you want to force a new conversation and ignore the old state
    screen: {
      isOn: true, // set this to true if you want to output results to a screen
    },
  },
};

let assistant;

// --- MODIFICACIÓN: Ajustar la pantalla inicial si no hay autenticación ---
// Verificar si el keyFilePath está vacío podría ser un indicador
// de que se necesita iniciar sesión a través del servidor.
if (assistantConfig['keyFilePath'] === '' && localStorage.getItem('isLoggedIn') !== 'true') {
  // Si no hay archivo de clave Y no estamos logueados (según serverAuth)
  // Mostrar pantalla para iniciar sesión.

  mainArea.innerHTML = `
    <div class="fade-in-from-bottom">
      <div style="margin: 30px 10px 8px 10px;">
        <div style="
          font-size: 30px;
          margin-top: 30px;
        ">
          Login Required
        </div>
        <div style="
          font-size: 21px;
          opacity: 0.502;
        ">
          Please login to use Google Assistant.
        </div>
      </div>
      <div class="no-auth-grid">
        <div class="no-auth-grid-icon">
          <img src="../res/auth.svg" alt="Auth" />
        </div>
        <div class="no-auth-grid-info">
          <div>
            Click the button below to login via the server.
          </div>
          <!-- Quitar detalles sobre Device Registration si ya no aplica -->
        </div>
      </div>
    </div>
  `;

  const suggestionParent = document.querySelector('.suggestion-parent');
  // Quitar enlace a wiki de autenticación si ya no es el método principal
  // const documentationLink = `${repoUrl}/wiki/Setup-Authentication-for-Google-Assistant-Unofficial-Desktop-Client`;

  suggestionParent.innerHTML = `
    <div
      class="suggestion"
      onclick="startServerAuth()"
    >
      <span>
        <img src="../res/login.svg" style=" /* Reemplaza con un icono adecuado */
          height: 15px;
          width: 15px;
          vertical-align: text-top;
          padding-right: 5px;
          padding-top: 2px;
          ${getEffectiveTheme() === 'light' ? 'filter: invert(1);' : ''}"
        >
      </span>
      Login with Server
    </div>
  `;

  assistantMicrophone.id = '';
  assistantMicrophone.classList.add('assistant-mic-disabled');

  // Detener la inicialización adicional del asistente si no estamos autenticados
  throw new Error("Authentication required via server. Halting assistant init.");

}
// --- FIN MODIFICACIÓN ---

try {
  assistant = new GoogleAssistant(config.auth);
}
catch (err) {
  console.group(...consoleMessage('Assistant Initialization failed', 'error'));
  console.error(err);

  // --- MODIFICACIÓN: Simplificar manejo de errores iniciales si dependen del key file obsoleto ---
  // Si el error es por el key file, guiar al login del servidor en lugar de configurar archivos.
  if (err.message.startsWith('Cannot find module') || err.name === 'TypeError') {
      console.log('Auth file error, but attempting server auth flow.');
      displayErrorScreen({
          title: 'Authentication Setup Needed',
          details: 'Could not initialize using local files. Please login using the server method.',
          subdetails: `Original Error: ${err.message}`, // Opcional: mostrar error original
      });

      const suggestionParent = document.querySelector('.suggestion-parent');
      suggestionParent.innerHTML = `
        <div class="suggestion" onclick="startServerAuth()">
          <span>
            <img src="../res/login.svg" style=" /* Icono adecuado */
              height: 20px;
              width: 20px;
              vertical-align: top;
              padding-right: 10px;
              ${getEffectiveTheme() === 'light' ? 'filter: invert(1);' : ''}"
            >
          </span>
          Login with Server
        </div>
        <div class="suggestion" onclick="openConfig()">
          <span>
            <img src="../res/settings.svg" style="
              height: 20px;
              width: 20px;
              vertical-align: top;
              padding-right: 10px;
              ${getEffectiveTheme() === 'light' ? 'filter: invert(1);' : ''}"
            >
          </span>
          Open Settings (Advanced)
        </div>
      `;
  }
  // --- FIN MODIFICACIÓN ---
  else {
    // Unexpected Error (mantener manejo genérico)
    displayErrorScreen({
      title: 'Unexpected Exception Occurred',
      details:
        'The Assistant failed to initialize due to some unexpected error. Try reloading the assistant.',
      subdetails: `Error: ${err.name} - ${err.message}`, // Añadir más detalles
    });

    const suggestionParent = document.querySelector('.suggestion-parent');
    suggestionParent.innerHTML = `
      <div class="suggestion" onclick="relaunchAssistant()">
        <span>
          <img src="../res/refresh.svg" style="
            height: 20px;
            width: 20px;
            vertical-align: top;
            padding-right: 5px;
            ${getEffectiveTheme() === 'light' ? 'filter: invert(1);' : ''}"
          >
        </span>
        Relaunch Assistant
      </div>
    `;
  }
  console.groupEnd();
  // Detener ejecución si hubo error de inicialización
  throw new Error("Assistant initialization failed.");
}


// starts a new conversation with the assistant
const startConversation = (conversation) => {
  conversation
    .on('audio-data', (data) => {
      // do stuff with the audio data from the server
      // usually send it to some audio output / file

      if (assistantConfig['enableAudioOutput'] && assistantWindow.isVisible()) {
        // If the query asked is typed,
        // check if user has disabled audio output for it
        if (
          config.conversation.textQuery
          && !assistantConfig['enableAudioOutputForTypedQueries']
        ) {
          return;
        }

        audPlayer.appendBuffer(Buffer.from(data));
      }
    })
    .on('end-of-utterance', () => {
      // do stuff when done speaking to the assistant
      // usually just stop your audio input
      stopMic();

      console.log('Loading results...');
    })
    .on('transcription', (data) => {
      // do stuff with the words you are saying to the assistant
      console.log('>', data, '\r');

      const colorForeground = getComputedStyle(document.documentElement)
        .getPropertyValue('--color-fg');

      suggestionArea.innerHTML = `
        <center>
          <span style="
            color: ${colorForeground}${!data.done ? '80' : ''};
            font-size: 20px"
          >
            ${data.transcription}
          </span>
        </center>
      `;

      if (data.done) {
        setQueryTitle(data.transcription);
        if (assistantConfig['enablePingSound']) audPlayer.playPingSuccess();
      }
    })
    .on('response', () => {
      // arg: text
      // do stuff with the text that the assistant said back
    })
    .on('volume-percent', () => {
      // arg: percent
      // do stuff with a volume percent change (range from 1-100)
    })
    .on('device-action', (action) => {
      // if you've set this device up to handle actions, you'll get that here
      console.group(...consoleMessage('Device Actions'));
      console.log(action);
      console.groupEnd();
    })
    .on('screen-data', (screen) => {
      // if the screen.isOn flag was set to true, you'll get the format and data of the output
      displayScreenData(screen, true);
    })
    .on('ended', (error, continueConversation) => {
      // once the conversation is ended, see if we need to follow up

      const isMicReadyForImmediateResponse = continueConversation
        && assistantConfig['enableMicOnImmediateResponse']
        && !mic.isActive;

      audPlayer.play();

      if (error) {
        console.group(...consoleMessage(
          'Error thrown after conversation ended',
          'error',
        ));
        console.error(error);
        console.groupEnd();

        displayErrorScreen({
          title: 'Unexpected Error',
          details: 'Unexpected Error occurred at the end of conversation',
          subdetails: `Error: ${error.message}`,
        });
      }
      else if (isMicReadyForImmediateResponse) {
        audPlayer.audioPlayer.addEventListener('waiting', () => startMic());
      }
      else {
        console.log(...consoleMessage('Conversation Complete'));
      }

      if (initHeadline) {
        initHeadline.innerText = supportedLanguages[assistantConfig['language']].welcomeMessage;
      }
    })
    .on('error', (error) => {
      console.group(...consoleMessage(
        'Error occurred during conversation',
        'error',
      ));
      console.error(error);
      console.groupEnd();

      if (error.details !== 'Service unavailable.') {
        suggestionArea.innerHTML = '<div class="suggestion-parent"></div>';
        const suggestionParent = document.querySelector('.suggestion-parent');

        // --- MODIFICACIÓN: Manejar invalid_grant redirigiendo al login del servidor ---
        if (error.details?.includes('invalid_grant')) {
          // Limpiar estado de login local si existe
          localStorage.removeItem('isLoggedIn');

          displayErrorScreen({
            icon: {
              path: '../res/auth_expired.svg', // O un icono de login
              style: 'margin-top: -5px;',
            },
            title: 'Authentication Required',
            details: 'Your session has expired or is invalid. Please login again.',
            subdetails: `Error: ${error.details}`,
          });

          suggestionParent.innerHTML = `
            <div class="suggestion" onclick="startServerAuth()">
              <span>
                <img src="../res/login.svg" style=" /* Icono adecuado */
                  height: 20px;
                  width: 20px;
                  vertical-align: top;
                  padding-right: 5px;
                  ${getEffectiveTheme() === 'light' ? 'filter: invert(1);' : ''}"
                >
              </span>
              Login Again
            </div>
            <div class="suggestion" onclick="openConfig()">
               <span>
                 <img src="../res/settings.svg" style="
                   height: 20px;
                   width: 20px;
                   vertical-align: top;
                   padding-right: 5px;
                   ${getEffectiveTheme() === 'light' ? 'filter: invert(1);' : ''}"
                 >
               </span>
              Open Settings (Advanced)
             </div>
           `;
        }
        // --- FIN MODIFICACIÓN ---
        else if (error.code === 14) { // Offline Error
          if (!error.details?.includes('No access or refresh token is set')) {
            displayErrorScreen({
              icon: {
                path: '../res/offline_icon.svg',
                style: 'margin-top: -5px;',
              },
              title: 'You are Offline!',
              details: 'Please check your Internet Connection...',
              subdetails: `Error: ${error.details}`,
            });
          }

          /**
           * System specific URI for network preferences.
           * @type {string}
           */
          let networkPrefURL;

          switch (process.platform) {
            case 'darwin':
              networkPrefURL = 'x-apple.systempreferences:com.apple.preferences.sharing?Internet';
              break;

            case 'win32':
              networkPrefURL = 'ms-settings:network-status';
              break;

            default:
              networkPrefURL = '';
          }

          if (process.platform === 'win32' || process.platform === 'darwin') {
            suggestionParent.innerHTML += `
                <div class="suggestion" onclick="openLink('${networkPrefURL}')">
                  <span>
                    <img src="../res/troubleshoot.svg" style="
                      height: 20px;
                      width: 20px;
                      vertical-align: top;
                      padding-right: 5px;
                      ${getEffectiveTheme() === 'light' ? 'filter: invert(1);' : ''}"
                    >
                  </span>
                  Network Preferences
                </div>
              `;
          }

          // Mantener el botón de reintentar
           suggestionParent.innerHTML = `
            <div class="suggestion" onclick="retryRecent(false)">
              <span>
                <img src="../res/refresh.svg" style="
                  height: 20px;
                  width: 20px;
                  vertical-align: top;
                  padding-right: 5px;
                  ${getEffectiveTheme() === 'light' ? 'filter: invert(1);' : ''}"
                >
              </span>
              Retry
            </div>
             ${suggestionParent.innerHTML}
           `;

          // --- MODIFICACIÓN: Añadir opción de re-login si el error es por falta de token y estamos offline ---
          if (error.details?.includes('No access or refresh token is set')) {
              displayErrorScreen({
                 icon: {
                   path: '../res/offline_icon.svg', // O un icono de login/error
                   style: 'margin-top: -5px;',
                 },
                 title: 'Login Needed or Offline',
                 details: 'Could not authenticate. Check your internet connection or try logging in again.',
                 subdetails: `Error: ${error.details}`,
               });
               suggestionParent.innerHTML = `
               <div class="suggestion" onclick="startServerAuth()">
                 <span>
                   <img src="../res/login.svg" style=" /* Icono login */
                     height: 20px;
                     width: 20px;
                     vertical-align: top;
                     padding-right: 5px;
                     ${getEffectiveTheme() === 'light' ? 'filter: invert(1);' : ''}"
                   >
                 </span>
                 Login Again
               </div>
               ${suggestionParent.innerHTML}  /* Mantener Retry y Network Prefs */
              `;
          }
          // --- FIN MODIFICACIÓN ---

        }
         // --- MODIFICACIÓN: Manejar error de token inválido (código 3 podría ser, verificar) ---
        else if (error.code === 3 /* || other relevant codes */) {
            if (error.details?.includes('No access or refresh token is set')) {
                 // Limpiar estado de login local si existe
                localStorage.removeItem('isLoggedIn');

                displayErrorScreen({
                    title: 'Authentication Problem',
                    details: 'There was an issue with your login session. Please login again.',
                    subdetails: 'Error: No access or refresh token is set',
                });

                const suggestionParent = document.querySelector('.suggestion-parent');
                suggestionParent.innerHTML = `
                    <div class="suggestion" onclick="startServerAuth()">
                        <span>
                            <img src="../res/login.svg" style=" /* Icono login */
                                height: 20px;
                                width: 20px;
                                vertical-align: top;
                                padding-right: 10px;
                                ${getEffectiveTheme() === 'light' ? 'filter: invert(1);' : ''}"
                            >
                        </span>
                        Login Again
                    </div>
                `;
            } else if (error.details?.includes('unsupported language_code')) {
              // Unsupported language code (mantener como estaba)
              const suggestionParent = document.querySelector('.suggestion-parent');
              displayErrorScreen({
                title: 'Invalid Language Code',
                details: `The language code "${assistantConfig.language}" is unsupported as of now.`,
                subdetails: `Error: ${error.details}`,
              });
              suggestionParent.innerHTML = `
                <div class="suggestion" onclick="openConfig('language')">
                  <span>
                    <img src="../res/troubleshoot.svg" style="
                      height: 20px;
                      width: 20px;
                      vertical-align: top;
                      padding-right: 5px;
                      ${getEffectiveTheme() === 'light' ? 'filter: invert(1);' : ''}"
                    >
                  </span>
                  Set Language
                </div>
                <div
                  class="suggestion"
                  onclick="openLink('https://developers.google.com/assistant/sdk/reference/rpc/languages')"
                >
                  Track language support
                </div>
                ${suggestionParent.innerHTML}
              `;
            } else {
                 // Otro error de código 3 genérico
                 displayErrorScreen({
                     title: 'Conversation Error',
                     details: 'An error occurred during the conversation.',
                     subdetails: `Error: ${error.message} (Code: ${error.code})`,
                 });
                  // Podrías añadir un botón de reintento genérico
                  suggestionParent.innerHTML = `
                   <div class="suggestion" onclick="retryRecent(false)">
                     <span>
                       <img src="../res/refresh.svg" style="
                         height: 20px;
                         width: 20px;
                         vertical-align: top;
                         padding-right: 5px;
                         ${getEffectiveTheme() === 'light' ? 'filter: invert(1);' : ''}"
                       >
                     </span>
                     Retry
                   </div>
                  `;
            }
        }
        // --- FIN MODIFICACIÓN ---
        else {
          // Otros errores genéricos
          displayErrorScreen({
            title: 'Unexpected Conversation Error',
            details: 'An unexpected error occurred.',
            subdetails: `Error: ${error.message} (Code: ${error.code})`,
          });
           suggestionParent.innerHTML = `
            <div class="suggestion" onclick="retryRecent(false)">
              <span>
                <img src="../res/refresh.svg" style="
                  height: 20px;
                  width: 20px;
                  vertical-align: top;
                  padding-right: 5px;
                  ${getEffectiveTheme() === 'light' ? 'filter: invert(1);' : ''}"
                >
              </span>
              Retry
            </div>
           `;
        }
      }
      // Código existente para detener loader y micrófono
      historyHead = history.length;
      deactivateLoader();
      stopMic();
    });
};

// will start a conversation and wait for audio data
// as soon as it's ready
assistant
  .on('ready', () => {
    isAssistantReady = true;
    console.log(...consoleMessage('Assistant Ready!'));
     // --- MODIFICACIÓN: Opcional: Verificar estado de login al estar listo ---
    // Si usas localStorage, podrías re-verificar aquí
    // const isLoggedIn = localStorage.getItem('isLoggedIn') === 'true';
    // if (!isLoggedIn && !document.querySelector('.error-area')) { // Evitar si ya hay error
    //    console.warn("Assistant ready but user not logged in according to localStorage.");
        // Podrías mostrar un mensaje o intentar el login de nuevo
        // startServerAuth();
    // }
    // --- FIN MODIFICACIÓN ---
  })
  .on('started', (conversation) => {
    console.log(...consoleMessage('Assistant Started Conversation!'));
    startConversation(conversation);

    // Stop Assistant Response Playback
    audPlayer.stop();

    // Mic Setup
    if (config.conversation.textQuery === undefined) {
      if (mic.isActive) {
        console.log('Mic already enabled...');
        return;
      }

      console.log('STARTING MICROPHONE...');
      if (assistantConfig['enablePingSound']) audPlayer.playPingStart();

      if (initHeadline) {
        initHeadline.innerText = supportedLanguages[assistantConfig['language']].listeningMessage;
      }

      // Set `p5jsMic` for visualization
      p5jsMic.start();
      const assistantMicrophoneParent = document.querySelector('#assistant-mic-parent');

      assistantMicrophoneParent.outerHTML = `
        <div id="assistant-mic-parent" class="fade-scale">
          <div id="amp-bar-group">
              <div class="amp-bar" style="background-color: #4285F4;"></div>
              <div class="amp-bar" style="background-color: #EA4335;"></div>
              <div class="amp-bar" style="background-color: #FBBC05;"></div>
              <div class="amp-bar" style="background-color: #34A853;"></div>
          </div>
        </div>
      `;

      // Add Event Listener to Stop Mic

      const ampBarGroup = document.querySelector('#assistant-mic-parent');

      ampBarGroup.onclick = () => {
        stopMic();
        if (assistantConfig['enablePingSound']) audPlayer.playPingStop();
      };

      // Setup mic for recording

      const processConversation = (data) => {
        const buffer = Buffer.from(data);
        conversation.write(buffer);

        const ampThreshold = 0.05;
        const amp = p5jsMic.getLevel();
        const ampBarList = document.querySelectorAll('.amp-bar');

        ampBarList[0].setAttribute('style', [
          'background-color: var(--color-blue);',
          `height: ${constrain(map(amp, 0, ampThreshold, 6, 25), 6, 25)}px;`,
        ].join(''));

        ampBarList[1].setAttribute('style', [
          'background-color: var(--color-red);',
          `height: ${constrain(map(amp, 0, ampThreshold, 6, 15), 6, 15)}px;`,
        ].join(''));

        ampBarList[2].setAttribute('style', [
          'background-color: var(--color-yellow);',
          `height: ${constrain(map(amp, 0, ampThreshold, 6, 30), 6, 30)}px;`,
        ].join(''));

        ampBarList[3].setAttribute('style', [
          'background-color: var(--color-green);',
          `height: ${constrain(map(amp, 0, ampThreshold, 6, 20), 6, 20)}px;`,
        ].join(''));
      };

      const micStoppedListener = () => {
        mic.off('data', processConversation);
        mic.off('mic-stopped', micStoppedListener);
        conversation.end();
      };

      mic.on('data', processConversation);
      mic.on('mic-stopped', micStoppedListener);
    }
  })
  .on('error', (err) => {
    // --- MODIFICACIÓN: Generalizar el manejo de error global si es de autenticación ---
    // Este error handler es más genérico, el específico de la conversación ya se modificó.
    // Si el error aquí también es claramente de autenticación (difícil saber sin probar),
    // podríamos redirigir a startServerAuth() aquí también. Por ahora, mantenemos el
    // comportamiento existente pero podríamos considerar cambiarlo.
    console.group(...consoleMessage('Error thrown by Assistant (Global Handler)', 'error'));
    console.error(err);
    console.groupEnd();

    const currentHTML = document.querySelector('body').innerHTML;
    const suggestionOnClickListeners = [
      ...document.querySelectorAll('.suggestion-parent > .suggestion'),
    ].map((btn) => btn.onclick);

    // Comprobar si el error sugiere un problema de autenticación que el servidor podría resolver
    const isLikelyAuthError = err.message?.includes('token') || err.message?.includes('auth');

    if (isLikelyAuthError && localStorage.getItem('isLoggedIn') !== 'true') {
        // Si parece error de auth y no estamos logueados, ofrecer login
        displayErrorScreen({
            title: 'Authentication Error',
            details: 'An authentication error occurred. Please try logging in again.',
            subdetails: `Error: ${err.message}`,
        });

        const suggestionParent = document.querySelector('.suggestion-parent');
        suggestionParent.innerHTML = `
            <div class="suggestion" onclick="startServerAuth()">
                <span>
                    <img src="../res/login.svg" style=" /* Icono login */
                        height: 20px;
                        width: 20px;
                        vertical-align: top;
                        padding-right: 10px;
                        ${getEffectiveTheme() === 'light' ? 'filter: invert(1);' : ''}"
                    >
                </span>
                Login Again
            </div>
            <div class="suggestion" onclick="relaunchAssistant()">
                 <span>
                   <img src="../res/refresh.svg" style="
                     height: 20px;
                     width: 20px;
                     vertical-align: top;
                     padding-right: 5px;
                     ${getEffectiveTheme() === 'light' ? 'filter: invert(1);' : ''}"
                   >
                 </span>
                 Relaunch Assistant
             </div>
        `;
    } else {
      // Mantener el manejo de error genérico existente
      displayErrorScreen({
        title: 'Unexpected Exception Occurred',
        details: 'An unexpected error occurred.',
        subdetails: `Error: ${err.message}`,
      });

      historyHead = history.length;

      const closeCurrentScreen = () => { /* ... código existente ... */ };

      const suggestionParent = document.querySelector('.suggestion-parent');
      suggestionParent.innerHTML = `
        <div class="suggestion" onclick="relaunchAssistant()">
          <span>
            <img src="../res/refresh.svg" style="
              height: 20px;
              width: 20px;
              vertical-align: top;
              padding-right: 5px;
              ${getEffectiveTheme() === 'light' ? 'filter: invert(1);' : ''}"
            >
          </span>
          Relaunch Assistant
        </div>
        <div id="ignore-btn" class="suggestion">
          Ignore
        </div>
      `;
      document.querySelector('#ignore-btn').onclick = closeCurrentScreen;

      // Eliminar el bloque else específico para 'No tokens specified' si ya no aplica
      // if (assistantConfig['savedTokensPath'] !== '') { ... } else { ... }
    }
    // --- FIN MODIFICACIÓN ---

    setTimeout(deactivateLoader, 200);
  });

/* User-Defined Functions */

/**
 * Escapes the quotation marks in the `string` for use in HTML and URL.
 * @param {string} string
 */
function escapeQuotes(string) {
  let newString = string.toString();

  newString = newString
    .replace(/["]/g, '&quot;')
    .replace(/[']/g, '&#39;');

  return newString;
}

/**
 * Classifies the response string provided by the assistant
 * and returns an `Object` containing the type of the
 * response and various parts of the response.
 *
 * @param {string} assistantResponseString
 * The response that has to be classified
 */
function inspectResponseType(assistantResponseString) {
  const googleTopResultRegex = /"(.*)" \(\s?(.+) - (.+?)\s?\)(?:\\n(.+))?/;
  const youtubeResultRegex = /(.+) \[(.+)\] \(\s?(.+?)\s?\)(?:\n---\n([^]+))?/;

  const searchResultMatch = assistantResponseString.match(googleTopResultRegex);
  const youtubeMatch = assistantResponseString.match(youtubeResultRegex);

  const isGoogleTopSearchResult = searchResultMatch != null
    ? assistantResponseString === searchResultMatch[0]
    : false;

  const isYoutubeResult = youtubeMatch != null
    ? youtubeMatch[3].startsWith('https://m.youtube.com/watch?v=')
    : false;

  const googleSearchPrompts = [
    'here\'s a result from search',
    'here\'s a result from the web',
    'here\'s the top search result',
    'this came back from google',
    'this came back from a search',
    'here\'s what i found on the web',
    'this is the top result',
    'here\'s what i found',
    'here\'s some info',
    'this is from wikipedia',
    'i found this on wikipedia',
    'here\'s an answer from wikipedia',
    'here\'s a wikipedia result',
    'here\'s the top wikipedia result',
    'wikipedia has this result',
    'here\'s something from wikipedia',
    'here\'s a result from wikipedia',
    'here\'s a matching wikipedia result',
  ];

  // Fix: Check if mainArea.innerText exists before accessing it
  const mainAreaText = mainArea?.innerText || '';
  const isGoogleSearchPrompt = googleSearchPrompts.includes(mainAreaText.toLowerCase());


  let type;
  let searchResultParts;

  if (isYoutubeResult) {
    type = 'youtube-result';
    searchResultParts = youtubeMatch.slice(1);
  }
  else if (isGoogleTopSearchResult) {
    type = 'google-search-result';
    searchResultParts = searchResultMatch.slice(1, 5);
  }
  else if (isGoogleSearchPrompt) {
    type = 'google-search-result-prompt';
    searchResultParts = null;
  }
  else {
    type = null;
    searchResultParts = null;
  }

  const dataObject = {
    type,
    searchResultParts,
    assistantResponseString,
  };

  return dataObject;
}

/**
 * Opens a `link` in the default browser.
 *
 * @param {string} link
 * Link that is to be opened in the browser.
 *
 * @param {boolean} autoMinimizeAssistantWindow
 * Minimize the Assistant Window after the link is opened.
 * _(Defaults to `true`)_
 */
function openLink(link, autoMinimizeAssistantWindow = true) {
  if (link === '') return;
  electronShell.openExternal(link);

  if (autoMinimizeAssistantWindow) {
    minimizeWindow();
  }
}

/**
 * Jumps to any result in `history` using `historyIndex`
 * @param {number} historyIndex
 */
function seekHistory(historyIndex) {
  historyHead = historyIndex;

  const historyItem = history[historyHead];
  displayScreenData(historyItem['screen-data']);
  setQueryTitle(historyItem['query']);

  deactivateLoader();
  updateNav();
}

/**
 * Decrements the `historyHead` and then shows previous result from the `history`
 *
 * @returns {boolean}
 * `true` if successfully jumps to previous result, `false` otherwise.
 */
function jumpToPrevious() {
  if (historyHead > 0) {
    historyHead--;
    seekHistory(historyHead);

    return true;
  }

  return false;
}

/**
 * Increments the `historyHead` and then shows next result from the `history`
 *
 * @returns {boolean}
 * `true` if successfully jumps to next result, `false` otherwise.
 */
function jumpToNext() {
  if (historyHead < history.length - 1) {
    historyHead++;
    seekHistory(historyHead);

    return true;
  }

  return false;
}

/**
 * Callback for file selection.
 *
 * @callback fileDialogCallback
 * @param {string[]} filePaths
 * @param {string[]} bookmarks
 */

/**
 * Opens dialog for selecting file (JSON)
 *
 * @param {fileDialogCallback} callback
 * The function called after a file is selected.
 *
 * @param {string} openDialogTitle
 * The Title for the dialog box.
 */
function openFileDialog(callback, openDialogTitle = null) {
  displayAsyncOpenDialog({
    title: openDialogTitle,
    filters: [{ name: 'JSON File', extensions: ['json'] }],
    properties: ['openFile'],
  })
    .then((result, bookmarks) => callback(result, bookmarks));
}

/**
 * Saves the `config` in the 'User Data' to retrieve
 * it the next time Assistant is launched.
 *
 * @param {*} assistantConfigObject
 * Pass config as an object or pass `null` to consider `assistantConfig`
 */
function saveConfig(assistantConfigObject = null) {
  fs.writeFile(
    configFilePath,
    JSON.stringify(!assistantConfigObject ? assistantConfig : assistantConfigObject),
    () => {
      console.log(...consoleMessage('Updated Config'));
      displayQuickMessage(
        `${supportedLanguages[assistantConfig['language']].settingsUpdatedText}`,
      );
    },
  );
}

/**
 * Opens the 'Settings' screen
 *
 * @param {string?} configItem
 * Highlights and scrolls instantly to the requested
 * config item by ID
 */
async function openConfig(configItem = null) {
  if (!document.querySelector('#config-screen')) {
    const currentHTML = document.querySelector('body').innerHTML;

    const suggestionOnClickListeners = [
      ...document.querySelectorAll('.suggestion-parent > .suggestion'),
    ].map((btn) => btn.onclick);

    mainArea.innerHTML = `
      <div id="config-screen" class="fade-in-from-bottom">
        <div style="
          font-size: 35px;
          font-weight: bold;
          margin: 0 10px;
        ">
          Settings
        </div>

        <div id="config-notice-parent"></div>

        <div style="padding: 20px 0">
          <div class="setting-label">
            AUTHENTICATION (Advanced) <!-- MODIFICACIÓN: Etiqueta opcional -->
            <hr />
          </div>
          <!-- MODIFICACIÓN: Añadir nota sobre la relevancia -->
          <div style="opacity: 0.7; margin: -10px 10px 15px 10px; font-size: 0.9em;">
             Note: These paths might be less relevant if using server-based login exclusively.
          </div>
          <div id="config-item__key-file-path" class="setting-item">
            <div class="setting-key">
              Key File Path (Optional) <!-- MODIFICACIÓN -->

              <span style="
                vertical-align: sub;
                margin-left: 10px;
              ">
                <img
                  src="../res/help.svg"
                  title="Your OAuth 2 Credentials.\nFile: 'client_secret_&lt;your_id&gt;.apps.googleusercontent.com.json'\n(May not be required for server login)"
                >
              </span>
            </div>
            <div class="setting-value">
              <input id="key-file-path" class="config-input" placeholder="Path to 'Key File'" />
              <label id="key-file-path-browse-btn" class="button">
                Browse
              </label>
            </div>
          </div>
          <div id="config-item__saved-tokens-path" class="setting-item">
            <div class="setting-key">
              Saved Tokens Path (Optional) <!-- MODIFICACIÓN -->

              <span style="
                vertical-align: sub;
                margin-left: 10px;
              ">
                <img
                  src="../res/help.svg"
                  title="The Token file previously provided by Google.\nFile: 'tokens.json'\n(May not be used by server login)"
                >
              </span>
            </div>
            <div class="setting-value">
              <input id="saved-tokens-path" class="config-input" placeholder="Path to 'Saved Tokens'" />
              <label id="saved-tokens-path-browse-btn" class="button">
                Browse
              </label>
            </div>
          </div>
          <!-- FIN MODIFICACIÓN -->
          <div class="setting-label">
            CONVERSATION
            <hr />
          </div>
          <div id="config-item__language" class="setting-item">
            <div class="setting-key">
              Language

              <span style="
                vertical-align: sub;
                margin-left: 10px;
              ">
                <img
                  src="../res/help.svg"
                  title="Language to converse with the Assistant"
                >
              </span>
            </div>
            <div class="setting-value" style="height: 35px;">
              <select id="lang-selector" style="padding-right: 10px;">
                ${Object.keys(supportedLanguages).map((langCode) => `
                  <option value="${langCode}">
                    ${supportedLanguages[langCode]['langName']}
                  </option>
                `).join('')}
              </select>
              <label id="detect-lang-btn" class="button" style="margin-left: 6px;">
                Detect Language
              </label>
            </div>
          </div>
          <div id="config-item__hotword" class="setting-item">
            <div class="setting-key">
              Hey Google / Ok Google

              <span style="
                vertical-align: sub;
                margin-left: 10px;
              ">
                <img
                  src="../res/help.svg"
                  title="If enabled, assistant will activate when it detects the hotword.\n(Might not work in a noisy environment)"
                >
              </span>
            </div>
            <div class="setting-value" style="height: 35px;">
              <label class="switch">
                <input id="hotword" type="checkbox">
                <span class="slider round"></span>
              </label>
            </div>
          </div>
          <div id="config-item__force-new-conv" class="setting-item">
            <div class="setting-key">
              Force New Conversation

              <span style="
                vertical-align: sub;
                margin-left: 10px;
              ">
                <img
                  src="../res/help.svg"
                  title="Turn it off if you want the assistant to remember the context."
                >
              </span>
            </div>
            <div class="setting-value" style="height: 35px;">
              <label class="switch">
                <input id="new-conversation" type="checkbox">
                <span class="slider round"></span>
              </label>
            </div>
          </div>
          <div id="config-item__audio-output" class="setting-item">
            <div class="setting-key">
              Enable Audio Output

              <span style="
                vertical-align: sub;
                margin-left: 10px;
              ">
                <img
                  src="../res/help.svg"
                  title="Mutes/Un-mutes Assistant's voice"
                >
              </span>
            </div>
            <div class="setting-value" style="height: 35px;">
              <label class="switch">
                <input id="audio-output" type="checkbox">
                <span class="slider round"></span>
              </label>
            </div>
          </div>
          <div id="config-item__audio-on-typed-query" class="setting-item">
            <div class="setting-key">
              Enable audio output for typed queries

              <span style="
                vertical-align: sub;
                margin-left: 10px;
              ">
                <img
                  src="../res/help.svg"
                  title="When enabled, assistant will speak the response for typed query"
                >
              </span>
            </div>
            <div class="setting-value" style="height: 35px;">
              <label class="switch">
                <input id="audio-on-typed-query" type="checkbox">
                <span class="slider round"></span>
              </label>
            </div>
          </div>
          <div id="config-item__mic-on-immediate-response" class="setting-item">
            <div class="setting-key">
              Enable microphone on Immediate Response

              <span style="
                vertical-align: sub;
                margin-left: 10px;
              ">
                <img
                  src="../res/help.svg"
                  title="Turns on microphone when the Assistant is expecting immediate response."
                >
              </span>
            </div>
            <div class="setting-value" style="height: 35px;">
              <label class="switch">
                <input id="immediate-response-mic" type="checkbox">
                <span class="slider round"></span>
              </label>
            </div>
          </div>
          <div id="config-item__mic-on-startup" class="setting-item">
            <div class="setting-key">
              Enable microphone on application startup

              <span style="
                vertical-align: sub;
                margin-left: 10px;
              ">
                <img
                  src="../res/help.svg"
                  title="Turns on microphone as soon as the Assistant is launched."
                >
              </span>
            </div>
            <div class="setting-value" style="height: 35px;">
              <label class="switch">
                <input id="enable-mic-startup" type="checkbox">
                <span class="slider round"></span>
              </label>
            </div>
          </div>
          <div class="setting-label">
            WINDOW
            <hr />
          </div>
          <div id="config-item__start-maximized" class="setting-item">
            <div class="setting-key">
              Start as Maximized

              <span style="
                vertical-align: sub;
                margin-left: 10px;
              ">
                <img
                  src="../res/help.svg"
                  title="Maximizes the assistant window every time you start it."
                >
              </span>
            </div>
            <div class="setting-value" style="height: 35px;">
              <label class="switch">
                <input id="start-maximized" type="checkbox">
                <span class="slider round"></span>
              </label>
            </div>
          </div>
          <div id="config-item__hide-on-first-launch" class="setting-item">
            <div class="setting-key">
              Hide on first launch

              <span style="
                vertical-align: sub;
                margin-left: 10px;
              ">
                <img
                  src="../res/help.svg"
                  title="When enabled, Assistant will be kept hidden on first launch and will require hotkey to show up.\nNote: The window will always stay hidden when launched at system startup."
                >
              </span>
            </div>
            <div class="setting-value" style="height: 35px;">
              <label class="switch">
                <input id="hide-on-first-launch" type="checkbox">
                <span class="slider round"></span>
              </label>
            </div>
          </div>
          <div id="config-item__auto-scale" class="setting-item">
            <div class="setting-key">
              Enable Auto Scaling

              <span style="
                vertical-align: sub;
                margin-left: 10px;
              ">
                <img
                  src="../res/help.svg"
                  title="Automatically scales the screen data provided by Google Assistant SDK optimizing it to display in the window.\nSome contents will still be auto scaled for legibility."
                >
              </span>
            </div>
            <div class="setting-value" style="height: 35px;">
              <label class="switch">
                <input id="auto-scale" type="checkbox">
                <span class="slider round"></span>
              </label>
            </div>
          </div>
          <div id="config-item__win-float-behavior" class="setting-item">
            <div class="setting-key">
              Window Float Behavior

              <span style="
                vertical-align: sub;
                margin-left: 10px;
              ">
                <img
                  src="../res/help.svg"
                  title="Configure window float behavior\n\nNormal: Window will not float\nAlways On Top: Window will float (appear on top of other apps)\nClose On Blur: Window will close when not in focus"
                >
              </span>
            </div>
            <div class="setting-value" style="height: 35px;">
              <select id="win-float-behavior-selector" style="padding-right: 50px;">
                <option value="normal">Normal</option>
                <option value="always-on-top">Always On Top</option>
                <option value="close-on-blur">Close on Blur</option>
              </select>
            </div>
          </div>
          <div id="config-item__escape-key-behavior" class="setting-item">
            <div class="setting-key">
              Escape Key Behavior

              <span style="
                vertical-align: sub;
                margin-left: 10px;
              ">
                <img
                  src="../res/help.svg"
                  title="Configure whether you want to close or minimize the assistant window with the escape key"
                >
              </span>
            </div>
            <div class="setting-value" style="height: 35px;">
              <select id="esc-key-behavior-selector" style="padding-right: 50px;">
                <option value="none">Do Nothing</option>
                <option value="minimize">Minimize Window</option>
                <option value="close">Close Window</option>
              </select>
            </div>
          </div>
          <div id="config-item__display-pref" class="setting-item">
            <div class="setting-key">
              Display Preference

              <span style="
                vertical-align: sub;
                margin-left: 10px;
              ">
                <img
                  src="../res/help.svg"
                  title="Allows selection of screen for displaying the window."
                >
              </span>
            </div>
            <div class="setting-value" style="height: 35px;">
              <select id="display-selector" style="padding-right: 50px;">
                ${
                  electron.remote.screen.getAllDisplays().map((display, index) => {
                    const { bounds, scaleFactor } = display;
                    const resolution = `${bounds.width * scaleFactor} x ${bounds.height * scaleFactor}`;

                    return `
                      <option value="${index + 1}">
                        Display ${index + 1} - (${resolution})
                      </option>
                    `;
                  })
                }
              </select>
            </div>
          </div>
          <div id="config-item__win-border" class="setting-item">
            <div class="setting-key">
              Window Border

              <span style="
                vertical-align: sub;
                margin-left: 10px;
              ">
                <img
                  src="../res/help.svg"
                  title="Window border creates distinction between the application and the background"
                >
              </span>
            </div>
            <div class="setting-value" style="height: 35px;">
              <select id="win-border-selector" style="padding-right: 50px;">
                <option value="none">None</option>
                <option value="minimal">Minimal</option>
                <option value="prominent">Prominent</option>
                <option value="color-shift">Color Shift</option>
              </select>
            </div>
          </div>
          <div class="setting-label">
            ACCESSIBILITY
            <hr />
          </div>
          <div id="config-item__ping-sound" class="setting-item">
            <div class="setting-key">
              Enable 'ping' feedback sound for microphone

              <span style="
                vertical-align: sub;
                margin-left: 10px;
              ">
                <img
                  src="../res/help.svg"
                  title="Plays a ping sound whenever the Assistant microphone is activated/deactivated."
                >
              </span>
            </div>
            <div class="setting-value" style="height: 35px;">
              <label class="switch">
                <input id="ping-sound" type="checkbox">
                <span class="slider round"></span>
              </label>
            </div>
          </div>
          <div class="setting-label">
            APPLICATION
            <hr />
          </div>
          <div id="config-item__launch-at-startup" class="setting-item">
            <div class="setting-key">
              Launch at System Startup

              <span style="
                vertical-align: sub;
                margin-left: 10px;
              ">
                <img
                  src="../res/help.svg"
                  title="Controls if the Assistant can launch on system startup."
                >
              </span>
            </div>
            <div class="setting-value" style="height: 35px;">
              <label class="switch">
                <input id="launch-at-startup" type="checkbox">
                <span class="slider round"></span>
              </label>
            </div>
          </div>
          <div id="config-item__notify-on-startup" class="setting-item">
            <div class="setting-key">
              Notify on app startup

              <span style="
                vertical-align: sub;
                margin-left: 10px;
              ">
                <img
                  src="../res/help.svg"
                  title="When enabled, the assistant will send you a notification when it is ready to launch."
                >
              </span>
            </div>
            <div class="setting-value" style="height: 35px;">
              <label class="switch">
                <input id="notify-on-startup" type="checkbox">
                <span class="slider round"></span>
              </label>
            </div>
          </div>
          <div id="config-item__close-to-tray" class="setting-item">
            <div class="setting-key">
              Always Close to Tray

              <span style="
                vertical-align: sub;
                margin-left: 10px;
              ">
                <img
                  src="../res/help.svg"
                  title="Keeps the Assistant in background even when it is closed."
                >
              </span>
            </div>
            <div class="setting-value" style="height: 35px;">
              <label class="switch">
                <input id="close-to-tray" type="checkbox">
                <span class="slider round"></span>
              </label>
            </div>
          </div>
          <div id="config-item__theme" class="setting-item">
            <div class="setting-key">
              Theme

              <span style="
                vertical-align: sub;
                margin-left: 10px;
              ">
                <img
                  src="../res/help.svg"
                  title="Changes Application's theme"
                >
              </span>
            </div>
            <div class="setting-value" style="height: 35px;">
              <select id="theme-selector">
                <option value="light">Light</option>
                <option value="dark">Dark</option>
                <option value="system">Use System Preferences</option>
              </select>
              <span id="curr-theme-icon"></span>
            </div>
          </div>
          <div id="config-item__hotkey-behavior" class="setting-item">
            <div class="setting-key">
              Configure Hotkey Behavior

              <span style="
                vertical-align: sub;
                margin-left: 10px;
              ">
                <img
                  src="../res/help.svg"
                  title="Configure what happens when '${
                    assistantConfig.assistantHotkey
                      .split('+').map(getNativeKeyName).join(' + ')
                  }' is triggered"
                >
              </span>
            </div>
            <div class="setting-value" style="height: 35px;">
              <select id="hotkey-behavior-selector">
                <option value="launch">Launch App</option>
                <option value="launch+mic">Launch App / Toggle Microphone</option>
                <option value="launch+close">Launch App / Close App</option>
              </select>
            </div>
          </div>
          <div id="config-item__assistant-hotkey" class="setting-item">
            <div class="setting-key">
              Assistant Hotkey

              <span style="
                vertical-align: sub;
                margin-left: 10px;
              ">
                <img
                  src="../res/help.svg"
                  title="Customize the hotkey for waking up the assistant.\n\nNote: Custom hotkeys are not bound to work always and will depend on\nthe desktop environment and foreground application."
                >
              </span>
            </div>
            <div class="setting-value" style="height: 35px; display: inline-flex;">
              <div id="hotkey-div" class="config-input" style="
                width: -webkit-fill-available;
                font-size: 16px;
              ">
                Hotkey
              </div>
              <label id="hotkey-reset-btn" class="button disabled">
                Reset
              </label>
            </div>
          </div>
          <div id="config-item__mic-src" class="setting-item">
            <div class="setting-key">
              Microphone Source

              <span style="
                vertical-align: sub;
                margin-left: 10px;
              ">
                <img
                  src="../res/help.svg"
                  title="Select microphone source for audio input"
                >
              </span>
            </div>
            <div class="setting-value" style="height: 35px;">
              <select
                id="mic-source-selector"
                style="width: -webkit-fill-available;"
              ></select>
            </div>
          </div>
          <div id="config-item__speaker-src" class="setting-item">
            <div class="setting-key">
              Speaker Source

              <span style="
                vertical-align: sub;
                margin-left: 10px;
              ">
                <img
                  src="../res/help.svg"
                  title="Select speaker source for audio output"
                >
              </span>
            </div>
            <div class="setting-value" style="height: 35px;">
              <select
                id="speaker-source-selector"
                style="width: -webkit-fill-available;"
              ></select>
            </div>
          </div>
          <div id="config-item__relaunch-assistant" class="setting-item">
            <div class="setting-key">
              Relaunch Assistant
            </div>
            <div class="setting-value" style="height: 35px;">
              <label class="button setting-item-button" onclick="relaunchAssistant()">
                <span>
                  <img src="../res/refresh.svg" style="
                    height: 20px;
                    width: 20px;
                    vertical-align: sub;
                    padding-right: 5px;
                    ${getEffectiveTheme() === 'light' ? 'filter: invert(1);' : ''}"
                  >
                </span>
                Relaunch Assistant
              </label>
            </div>
          </div>
          <div id="config-item__fallback-mode" class="setting-item">
            <div class="setting-key">
              Fallback Mode

              <span style="
                vertical-align: sub;
                margin-left: 10px;
              ">
                <img
                  src="../res/help.svg"
                  title="${[
                    'Fallback mode temporarily forces your settings to fallback to their defaults.',
                    'Useful in cases where you think the app is not working as intended with the current settings.',
                  ].join('\n')}"
                >
              </span>
            </div>
            <div class="setting-value" style="height: 35px;">
              <label class="button setting-item-button" onclick="${!isFallbackMode()
                ? 'restartInFallbackMode()'
                : 'restartInNormalMode()'
              }">
                <span>
                  <img src="../res/fallback.svg" style="
                    height: 20px;
                    width: 20px;
                    vertical-align: sub;
                    padding-right: 5px;
                    ${getEffectiveTheme() === 'light' ? 'filter: invert(1);' : ''}"
                  >
                </span>
                ${!isFallbackMode()
                  ? 'Restart session with default settings (Fallback)'
                  : 'Restart session in Normal mode'
                }
              </label>
            </div>
          </div>
          <div id="config-item__quit-assistant" class="setting-item">
            <div class="setting-key">
              Quit from Tray

              <span style="
                vertical-align: sub;
                margin-left: 10px;
              ">
                <img
                  src="../res/help.svg"
                  title="Completely exit the Assistant (even from background)"
                >
              </span>
            </div>
            <div class="setting-value" style="height: 35px;">
              <label class="button setting-item-button" onclick="quitApp()">
                Quit
              </label>
            </div>
          </div>
          <div class="setting-label">
            DEVELOPER OPTIONS
            <hr />
          </div>
          <div id="config-item__show-dev-tools" class="setting-item">
            <div class="setting-key">
              Show Developer Tools
            </div>
            <div class="setting-value" style="height: 35px;">
              <label
                class="button setting-item-button"
                onclick="assistantWindow.webContents.openDevTools({mode: 'undocked'})"
              >
                Open DevTools
              </label>
            </div>
          </div>
          <div id="config-item__app-data-dir" class="setting-item">
            <div class="setting-key">
              Application Data Directory

              <span style="
                vertical-align: sub;
                margin-left: 10px;
              ">
                <img
                  src="../res/help.svg"
                  title="Opens the directory where Assistant's application data is stored"
                >
              </span>
            </div>
            <div class="setting-value" style="height: 35px;">
              <label
                class="button setting-item-button"
                onclick="electronShell.openPath(userDataPath)"
              >
                Open App Data Folder
              </label>
            </div>
          </div>
          <div id="config-item__cmd-args" class="setting-item">
            <div class="setting-key">
              Show Command Line Arguments

              <span style="
                vertical-align: sub;
                margin-left: 10px;
              ">
                <img
                  src="../res/help.svg"
                  title="Display command line arguments supplied to the process"
                >
              </span>
            </div>
            <div class="setting-value" style="height: 35px;">
              <label
                class="button setting-item-button"
                onclick="showArgsDialog()"
              >
                Show Command Line Args
              </label>
            </div>
          </div>
          <div id="config-item__about-assistant" class="setting-item">
            <div class="setting-key">
              About Assistant

              <span style="
                vertical-align: sub;
                margin-left: 10px;
              ">
                <img
                  src="../res/help.svg"
                  title="Nerdy information for developers"
                >
              </span>
            </div>
            <div class="setting-value" style="height: 35px;">
              <label
                class="button setting-item-button"
                onclick="showAboutBox()"
              >
                About
              </label>
            </div>
          </div>
          <div class="setting-label">
            FEEDBACK & LINKS
            <hr />
          </div>
          <!-- MODIFICACIÓN: Ocultar o cambiar la guía de autenticación si ya no aplica -->
          <!--
          <div id="config-item__link-setup-auth-wiki" class="setting-item">
            <div class="setting-key">
              How to setup authentication?
            </div>
            <div class="setting-value" style="height: 35px;">
              <label class="button setting-item-button" onclick="openLink('${repoUrl}/wiki/Setup-Authentication-for-Google-Assistant-Unofficial-Desktop-Client')">
                <span>
                  <img src="../res/open_link.svg" style="
                    height: 16px;
                    width: 16px;
                    vertical-align: sub;
                    padding-right: 5px;
                    ${getEffectiveTheme() === 'light' ? 'filter: invert(1);' : ''}"
                  >
                </span>
                Show Authentication Guide Wiki
              </label>
            </div>
          </div>
          -->
          <!-- FIN MODIFICACIÓN -->
          <div id="config-item__link-faq" class="setting-item">
            <div class="setting-key">
              Stuck on an issue?
            </div>
            <div class="setting-value" style="height: 35px;">
              <label class="button setting-item-button" onclick="openLink('${repoUrl}/wiki/Frequently-Asked-Questions-(FAQ)')">
                <span>
                  <img src="../res/open_link.svg" style="
                    height: 16px;
                    width: 16px;
                    vertical-align: sub;
                    padding-right: 5px;
                    ${getEffectiveTheme() === 'light' ? 'filter: invert(1);' : ''}"
                  >
                </span>
                Check the FAQs
              </label>
            </div>
          </div>
          <div id="config-item__link-bug-report" class="setting-item">
            <div class="setting-key">
              Found a new bug?
            </div>
            <div class="setting-value" style="height: 35px;">
              <label
                id="bug-report-button"
                class="button setting-item-button"
              >
                <span>
                  <img src="../res/open_link.svg" style="
                    height: 16px;
                    width: 16px;
                    vertical-align: sub;
                    padding-right: 5px;
                    ${getEffectiveTheme() === 'light' ? 'filter: invert(1);' : ''}"
                  >
                </span>
                Create a bug report issue
              </label>
            </div>
          </div>
          <div id="config-item__link-feature-request" class="setting-item">
            <div class="setting-key">
              Have a suggestion or an idea?
            </div>
            <div class="setting-value" style="height: 35px;">
              <label
                class="button setting-item-button"
                onclick="openLink('${repoUrl}/issues/new?assignees=Melvin-Abraham&labels=%E2%9C%A8+enhancement&template=feature_request.yml&title=%5B%F0%9F%92%A1+Feature+Request%5D%3A+')"
              >
                <span>
                  <img src="../res/open_link.svg" style="
                    height: 16px;
                    width: 16px;
                    vertical-align: sub;
                    padding-right: 5px;
                    ${getEffectiveTheme() === 'light' ? 'filter: invert(1);' : ''}"
                  >
                </span>
                Create a feature request issue
              </label>
            </div>
          </div>
          <div class="setting-label">
            ABOUT
            <hr />
          </div>
          <div class="setting-item settings-about-section">
            <div
              class="setting-key"
              style="margin-right: 35px; margin-left: auto; margin-top: 5px;"
            >
              <img
                src="../res/Assistant Logo.svg"
                style="filter: drop-shadow(0 4px 4px #00000020);"
              />
            </div>
            <div class="setting-value">
              <div style="font-size: 23px; font-weight: bold;">
                Google Assistant
              </div>
              <div class="disabled" style="margin-top: 5px;">
                Version ${app.getVersion()}
              </div>
              <div style="margin-top: 20px;" id="check-for-update-section">
                <span>
                  <img src="../res/check_update.svg" style="
                    height: 20px;
                    width: 20px;
                    vertical-align: -webkit-baseline-middle;
                    padding-right: 5px;"
                  >
                </span>
                <span style="vertical-align: -webkit-baseline-middle; margin-right: 15px;">
                  Check for new version
                </span>
                <label class="button setting-item-button" id="check-for-update-btn">
                  Check for Updates
                </label>
              </div>
              <div
                id="config-item__whats-new"
                class="accordion"
                style="
                  margin-top: 40px;
                  background: #1e90ff30;
                  padding: 10px 30px 18px 30px;
                  border-radius: 10px;
                "
              >
                <input type="checkbox" id="whats-new" />
                <label for="whats-new" class="accordion-tile">
                  <div style="width: 100%; display: inline-block;">
                    <span>
                      <img src="../res/light_bulb.svg" style="
                        height: 20px;
                        width: 20px;
                        vertical-align: sub;
                        padding-right: 5px;
                        ${getEffectiveTheme() === 'light' ? '' : 'filter: invert(1);'}"
                      >
                    </span>

                    <span id="changelog-accordion-title-text" style="width: 100%;">
                      What's new in this version
                    </span>

                    <span
                      class="accordion-chevron"
                      style="${getEffectiveTheme() === 'light' ? '' : 'filter: invert(1);'}">
                      <img src="../res/chevron_down.svg" />
                    </span>
                  </div>
                </label>

                <div id="changelog-accordion-content" class="accordion-content">
                  <div style="margin-top: 30px;"></div>
                </div>
              </div>
              <div id="config-item__update-options">
                <div class="setting-item">
                  <div class="setting-key">
                    Enable Auto-Update
                  </div>
                  <div class="setting-value">
                    <label class="switch">
                      <input id="auto-update" type="checkbox">
                      <span class="slider round"></span>
                    </label>
                  </div>
                </div>
                <hr>
                <div class="setting-item">
                  <div class="setting-key">
                    Download installer externally
                  </div>
                  <div class="setting-value">
                    <label class="button setting-item-button" id="download-external-btn">
                      <span>
                        <img src="../res/open_link.svg" style="
                          height: 16px;
                          width: 16px;
                          vertical-align: sub;
                          padding-right: 5px;
                          ${getEffectiveTheme() === 'light' ? 'filter: invert(1);' : ''}"
                        >
                      </span>

                      Download installer
                    </label>
                  </div>
                </div>
              </div>
              <div style="margin-top: 40px;">
                <div class="disabled" style="margin-bottom: 5px;">
                  Google Assistant Unofficial Desktop Client is an open source project
                </div>
                <span style="vertical-align: -webkit-baseline-middle; margin-right: 15px;">
                  Source code available in GitHub
                </span>
                <label class="button setting-item-button" onclick="openLink('${repoUrl}')">
                  <span>
                    <img src="../res/github.svg" style="
                      height: 20px;
                      width: 20px;
                      vertical-align: sub;
                      padding-right: 5px;
                      ${getEffectiveTheme() === 'light' ? 'filter: invert(1);' : ''}"
                    >
                  </span>
                  Fork on GitHub
                </label>
              </div>
            </div>
          </div>
        </div>
      </div>
    `;

    // --- Resto del código de openConfig (banners, manejo de fallbacks, etc.) ---
    // ... (código existente para configNotice, fallbackMode, mic inaccessible) ...
    const configNotice = mainArea.querySelector('#config-notice-parent');
    // ... (código para banners, fallback, mic, etc.) ...


    // --- Obtener referencias a elementos (código existente) ---
    const keyFilePathInput = mainArea.querySelector('#key-file-path');
    const savedTokensPathInput = mainArea.querySelector('#saved-tokens-path');
    // ... (resto de selectores existentes) ...
    const languageSelector = document.querySelector('#lang-selector');
    const respondToHotword = document.querySelector('#hotword');
    const forceNewConversationCheckbox = document.querySelector('#new-conversation');
    const enableAudioOutput = document.querySelector('#audio-output');
    const enableAudioOutputForTypedQueries = document.querySelector('#audio-on-typed-query');
    const enableMicOnInstantResponse = document.querySelector('#immediate-response-mic');
    const enableMicOnStartup = document.querySelector('#enable-mic-startup');
    const startAsMaximized = document.querySelector('#start-maximized');
    const hideOnFirstLaunch = document.querySelector('#hide-on-first-launch');
    const winFloatBehaviorSelector = document.querySelector('#win-float-behavior-selector');
    const escKeyBehaviorSelector = document.querySelector('#esc-key-behavior-selector');
    const microphoneSourceSelector = document.querySelector('#mic-source-selector');
    const speakerSourceSelector = document.querySelector('#speaker-source-selector');
    const displayPreferenceSelector = document.querySelector('#display-selector');
    const winBorderSelector = document.querySelector('#win-border-selector');
    const autoDownloadUpdates = document.querySelector('#auto-update');
    const launchAtStartUp = document.querySelector('#launch-at-startup');
    const notifyOnStartUp = document.querySelector('#notify-on-startup');
    const alwaysCloseToTray = document.querySelector('#close-to-tray');
    const assistantHotkeyBar = document.querySelector('#hotkey-div');
    const enablePingSound = document.querySelector('#ping-sound');
    const enableAutoScaling = document.querySelector('#auto-scale');
    const themeSelector = document.querySelector('#theme-selector');
    const hotkeyBehaviorSelector = document.querySelector('#hotkey-behavior-selector');


    // --- Lógica de configuración (mayormente existente) ---
    keyFilePathInput.addEventListener(
      'focusout',
      () => validatePathInput(keyFilePathInput),
    );

    // Assistant Hotkey (código existente)
    const keybindingListener = new KeyBindingListener();
    // ... (resto del código para hotkey) ...


    // Populate microphone and speaker source selectors (código existente)
    const deviceList = await navigator.mediaDevices.enumerateDevices();
    // ... (código para llenar selectores) ...


    // Disable "Launch at system startup" (código existente)
    if (process.env.DEV_MODE) {
       // ... (código existente) ...
    }

    // Disable "Enable Auto-Update" (código existente)
    const doesUseGenericUpdater = ipcRenderer.sendSync('update:doesUseGenericUpdater');
     if (doesUseGenericUpdater) {
       // ... (código existente) ...
     }

    // Disable `enableAudioOutputForTypedQueries` (código existente)
    enableAudioOutput.onchange = () => {
       // ... (código existente) ...
    };


    // --- Asignar valores de config a UI (código existente) ---
    keyFilePathInput.value = assistantConfig['keyFilePath'];
    savedTokensPathInput.value = assistantConfig['savedTokensPath'];
    // ... (resto de asignaciones existentes) ...
    languageSelector.value = assistantConfig['language'];
    respondToHotword.checked = assistantConfig['respondToHotword'];
    forceNewConversationCheckbox.checked = assistantConfig['forceNewConversation'];
    enableAudioOutput.checked = assistantConfig['enableAudioOutput'];
    enableAudioOutputForTypedQueries.checked = assistantConfig['enableAudioOutputForTypedQueries'];
    enableMicOnInstantResponse.checked = assistantConfig['enableMicOnImmediateResponse'];
    enableMicOnStartup.checked = assistantConfig['enableMicOnStartup'];
    startAsMaximized.checked = assistantConfig['startAsMaximized'];
    hideOnFirstLaunch.checked = assistantConfig['hideOnFirstLaunch'];
    winFloatBehaviorSelector.value = assistantConfig['windowFloatBehavior'];
    escKeyBehaviorSelector.value = assistantConfig['escapeKeyBehavior'];
    microphoneSourceSelector.value = assistantConfig['microphoneSource'];
    speakerSourceSelector.value = assistantConfig['speakerSource'];
    displayPreferenceSelector.value = assistantConfig['displayPreference'];
    winBorderSelector.value = assistantConfig['windowBorder'];
    autoDownloadUpdates.checked = assistantConfig['autoDownloadUpdates'];
    launchAtStartUp.checked = assistantConfig['launchAtStartup'];
    notifyOnStartUp.checked = assistantConfig['notifyOnStartup'];
    alwaysCloseToTray.checked = assistantConfig['alwaysCloseToTray'];
    enablePingSound.checked = assistantConfig['enablePingSound'];
    enableAutoScaling.checked = assistantConfig['enableAutoScaling'];
    themeSelector.value = assistantConfig['theme'];
    hotkeyBehaviorSelector.value = assistantConfig['hotkeyBehavior'];
    // ... (código para hotkey bar text) ...

    // --- Asignar listeners a botones (código existente) ---
    mainArea.querySelector('#key-file-path-browse-btn').onclick = () => {
      // ... (código existente) ...
    };
    mainArea.querySelector('#saved-tokens-path-browse-btn').onclick = () => {
      // ... (código existente) ...
    };
    mainArea.querySelector('#detect-lang-btn').onclick = () => {
      // ... (código existente) ...
    };


    validatePathInput(keyFilePathInput); // Validar ruta al cargar

    // --- Lógica de icono de tema (código existente) ---
    const setCurrentThemeIcon = () => { /* ... código existente ... */ };
    setCurrentThemeIcon();
    document.querySelector('#theme-selector').onchange = () => { setCurrentThemeIcon(); };


    // --- Botones de Guardar/Cancelar (código existente) ---
    suggestionArea.innerHTML = '<div class="suggestion-parent"></div>';
    const suggestionParent = document.querySelector('.suggestion-parent');
    suggestionParent.innerHTML = `
      <div id="save-config" class="suggestion"> Save </div>
      <div id="cancel-config-changes" class="suggestion"> Cancel </div>
    `;

    historyHead++; // Incrementar aquí como antes

    const closeCurrentScreen = () => { /* ... código existente para cerrar config ... */ };

    // --- Lógica de sección de actualización (código existente) ---
    const downloadExternallyButton = document.querySelector('#download-external-btn');
    // ... (código existente para updater status y changelog) ...


    document.querySelector('#cancel-config-changes').onclick = () => {
      closeCurrentScreen();
      keybindingListener.stopListening(); // Detener listener si se cancela
    };

    // --- Lógica de guardar configuración ---
    document.querySelector('#save-config').onclick = () => {
      // --- MODIFICACIÓN: Quitar validaciones estrictas de savedTokensPath si ya no es obligatorio ---
      // La lógica original asumía que savedTokensPath era necesario si keyFilePath existía.
      // Comentar o eliminar estas validaciones si ya no aplican al flujo de servidor.
      /*
      if (
        keyFilePathInput.value.trim() !== ''
        && savedTokensPathInput.value.trim() === ''
      ) {
        // ... diálogo original ...
      } else if (
        fs.existsSync(savedTokensPathInput.value)
        && fs.statSync(savedTokensPathInput.value).isDirectory()
      ) {
        // ... diálogo original ...
      } else if (
        keyFilePathInput.value.trim() !== ''
        && !fs.existsSync(path.dirname(savedTokensPathInput.value))
      ) {
       // ... diálogo original ...
      }
      // ... (validación de creación de archivo de token) ...
      try {
        if (!fs.existsSync(savedTokensPathInput.value) && keyFilePathInput.value !== '') {
          fs.writeFileSync(savedTokensPathInput.value, '');
        }
      } catch (err) {
        // ... manejo de error original ...
      }
      */
      // --- FIN MODIFICACIÓN ---

      // Validar keyFilePath si todavía se usa (opcional)
      if (validatePathInput(keyFilePathInput, true)) {
        // Warn users if saving settings in fallback mode (código existente)
        if (isFallbackMode()) { /* ... código existente ... */ }

        // Determine if relaunch is required (podría cambiar)
        let relaunchRequired = false;
        // --- MODIFICACIÓN: Relaunch podría ser necesario solo si cambian archivos locales aún usados ---
        if (
          keyFilePathInput.value !== assistantConfig['keyFilePath']
          || savedTokensPathInput.value !== assistantConfig['savedTokensPath']
        ) {
           // Si cambian los archivos locales (y aún los usas para algo), quizá sí se necesite relanzar
           // Si ya no se usan, esta condición es irrelevante para el login.
          // relaunchRequired = true;
          console.warn("Key file or saved tokens path changed. Relaunch might be needed if these files are still actively used by the library.");
        }
        // --- FIN MODIFICACIÓN ---


        // Set display preference update flag (código existente)
        let shouldUpdateDisplayPref = true;
        // ... (código existente) ...


        // Actualizar hotkey (código existente)
        if (assistantConfig['assistantHotkey'] !== assistantHotkey) {
           // ... (código existente) ...
        }


        // --- Asignar valores de UI a assistantConfig (código existente) ---
        assistantConfig['keyFilePath'] = keyFilePathInput.value; // Guardar aunque sea opcional
        assistantConfig['savedTokensPath'] = savedTokensPathInput.value; // Guardar aunque sea opcional
        // ... (resto de asignaciones existentes) ...
        assistantConfig['language'] = languageSelector.value;
        assistantConfig['respondToHotword'] = respondToHotword.checked;
        assistantConfig['forceNewConversation'] = forceNewConversationCheckbox.checked;
        assistantConfig['enableAudioOutput'] = enableAudioOutput.checked;
        assistantConfig['enableAudioOutputForTypedQueries'] = enableAudioOutputForTypedQueries.checked;
        assistantConfig['enableMicOnImmediateResponse'] = enableMicOnInstantResponse.checked;
        assistantConfig['enableMicOnStartup'] = enableMicOnStartup.checked;
        assistantConfig['startAsMaximized'] = startAsMaximized.checked;
        assistantConfig['hideOnFirstLaunch'] = hideOnFirstLaunch.checked;
        assistantConfig['windowFloatBehavior'] = winFloatBehaviorSelector.value;
        assistantConfig['escapeKeyBehavior'] = escKeyBehaviorSelector.value;
        assistantConfig['microphoneSource'] = microphoneSourceSelector.value;
        assistantConfig['speakerSource'] = speakerSourceSelector.value;
        assistantConfig['displayPreference'] = displayPreferenceSelector.value;
        assistantConfig['windowBorder'] = winBorderSelector.value;
        assistantConfig['autoDownloadUpdates'] = autoDownloadUpdates.checked;
        assistantConfig['launchAtStartup'] = launchAtStartUp.checked;
        assistantConfig['notifyOnStartup'] = notifyOnStartUp.checked;
        assistantConfig['alwaysCloseToTray'] = alwaysCloseToTray.checked;
        assistantConfig['enablePingSound'] = enablePingSound.checked;
        assistantConfig['enableAutoScaling'] = enableAutoScaling.checked;
        assistantConfig['theme'] = themeSelector.value;
        assistantConfig['hotkeyBehavior'] = hotkeyBehaviorSelector.value;
        assistantConfig['assistantHotkey'] = assistantHotkey;


        // --- Aplicar configuraciones (código existente) ---
        config.conversation.isNew = assistantConfig['forceNewConversation'];
        config.conversation.lang = assistantConfig['language'];
        // ... (resto de aplicaciones: login item, always on top, border, updater, audio devices, hotword) ...
        keybindingListener.stopListening(); // Detener listener al guardar


        // Notify about config changes to main process (código existente)
        ipcRenderer.send('update-config', assistantConfig);

        // Save and exit screen (código existente)
        saveConfig();
        closeCurrentScreen();
        setTheme();

        // Reposition window (código existente)
        if (shouldUpdateDisplayPref) { /* ... código existente ... */ }

        // Request user to relaunch assistant if necessary (código existente, pero 'relaunchRequired' puede haber cambiado)
        if (relaunchRequired) { /* ... código existente para mostrar pantalla de relanzar ... */ }
      }
    };
  }

  // Scroll to requested config item (código existente)
  if (configItem) { /* ... código existente ... */ }
}


/**
 * Updates the Navigation: 'Next' and 'Previous' buttons
 */
function updateNav() {
  const newNav = `
    <img
      id="prev-btn"
      class="${historyHead <= 0 ? 'disabled' : 'ico-btn '}"
      type="icon"
      src="../res/prev_btn.svg"
      alt="Previous Result"
    >

    <img
      id="next-btn"
      class="${historyHead >= history.length - 1 ? 'disabled' : 'ico-btn '}"
      type="icon"
      src="../res/next_btn.svg"
      alt="Next Result"
    >

    <div
      id="settings-btn"
      class="ico-btn"
      type="icon"
      style="display: inline-block;"
    >
      <img
        type="icon"
        src="../res/settings_btn.svg"
        alt="Settings"
      >
    </div>
  `;

  document.querySelector('#nav-region').innerHTML = newNav;
  document.querySelector('#prev-btn').onclick = () => jumpToPrevious();
  document.querySelector('#next-btn').onclick = () => jumpToNext();
  document.querySelector('#settings-btn').onclick = () => openConfig();
}

/**
 * Ask a `query` from assistant in text.
 * @param {string} query
 */
function assistantTextQuery(query) {
  if (query.trim()) {
    audPlayer.stop();

    config.conversation['textQuery'] = query;
    // --- MODIFICACIÓN: Asegurarse que el asistente está listo antes de empezar ---
    if (isAssistantReady && assistant) {
        assistant.start(config.conversation);
        setQueryTitle(query);
        assistantInput.value = '';
        currentTypedQuery = '';
        stopMic(); // Detener micro si estaba activo
    } else {
        console.error("Assistant not ready or not initialized. Cannot send text query.");
        displayQuickMessage("Assistant is not ready yet.");
        // Podría intentar relanzar o mostrar error
    }
    // --- FIN MODIFICACIÓN ---
  }
}

/**
 * Set the `query` in titlebar
 * @param {string} query
 */
function setQueryTitle(query) {
  const init = document.querySelector('.init');

  if (init != null) {
    init.innerHTML = `
      <center id="assistant-logo-main-parent" style="margin-top: 80px;">
        <img id="assistant-logo-main" src="../res/Google_Assistant_logo.svg" alt="">
      </center>`;
  }

  document.querySelector('.app-title').innerHTML = `
    <span class="fade-in-from-bottom">
      ${query}
    </span>`;

  activateLoader();
}

/**
 * Returns the title displayed in the 'titlebar'
 * @returns {string} Title
 */
function getCurrentQuery() {
  // Fix: Ensure .app-title exists before accessing innerText
  const titleElement = document.querySelector('.app-title');
  return titleElement ? titleElement.innerText : '';
}


/**
 * Retry/Refresh result for the query displayed in the titlebar
 *
 * @param {boolean} popHistory
 * Remove the recent result from history and replace it with the refreshed one.
 * _(Defaults to `true`)_
 */
function retryRecent(popHistory = true) {
  if (popHistory && history.length > 0) history.pop(); // Check history length
  assistantTextQuery(getCurrentQuery());
}


/**
 * Display a preloader near the titlebar to notify
 * user that a task is being performed.
 */
function activateLoader() {
  const loaderArea = document.querySelector('#loader-area');
   if (loaderArea) loaderArea.classList.value = 'loader'; // Check existence
}


/**
 * Make the preloader near the titlebar disappear
 * once the task is completed.
 */
function deactivateLoader() {
  const loaderArea = document.querySelector('#loader-area');
   if (loaderArea) loaderArea.classList.value = ''; // Check existence
}


/**
 * Displays Error Screen.
 *
 * @param {Object} opts
 * Options to be passed to define and customize the error screen
 *
 * @param {string=} opts.errContainerId
 * Set the `id` of error container
 *
 * @param {Object} opts.icon
 * The icon object
 *
 * @param {string=} opts.icon.path
 * The Path to the icon to be used as Error Icon
 *
 * @param {string=} opts.icon.style
 * Additional styles applied to the icon
 *
 * @param {string=} opts.title
 * The Title of the error
 *
 * @param {string=} opts.details
 * Description of the error
 *
 * @param {string=} opts.subdetails
 * Sub-details/Short description of the error
 *
 * @param {string=} opts.customStyle
 * Any custom styles that you want to apply
 */
function displayErrorScreen(opts = {}) {
  const options = {
    errContainerId: '',
    icon: {
      path: '',
      style: '',
    },
    title: 'Error',
    details: 'No error description was provided.',
    subdetails: '',
    customStyle: '',
  };

  Object.assign(options, opts);

  const iconObj = {
    path: '../res/warning.svg',
    style: '',
  };

   // Use provided icon path if available
  if (opts.icon?.path) {
      iconObj.path = opts.icon.path;
  }
  // Use provided icon style if available
  if (opts.icon?.style) {
      iconObj.style = opts.icon.style;
  }
  options.icon = iconObj;


  mainArea.innerHTML = `
    <div id="${options.errContainerId}" class="error-area fade-in-from-bottom" style="${options.customStyle}">
      <img class="err-icon" style="${options.icon.style}" src="${options.icon.path}">

      <div class="err-title">
        ${options.title}
      </div>

      <div class="err-details">
        ${options.details}

        <div class="err-subdetails">
          ${options.subdetails}
        </div>
      </div>
    </div>
  `;
}

/**
 * Process the *Screen Data* and display the `result` and set `suggestions`.
 *
 * @param {*} screen
 * The screen data provided by Assistant SDK
 *
 * @param {boolean} pushToHistory
 * Push the *screen data* to the `history`.
 * _(Defaults to `false`)_
 *
 * @param {"dark" | "light" | "system"} theme
 * Theme to be applied on screen data.
 * Leave this parameter to infer from `assistantConfig.theme`
 */
async function displayScreenData(screen, pushToHistory = false, theme = null) {
    // ... (código existente de displayScreenData sin cambios relevantes a la autenticación) ...
     deactivateLoader();

  const htmlString = screen.data.toString();
  const htmlDocument = parser.parseFromString(htmlString, 'text/html');
  suggestionArea.innerHTML = '<div class="suggestion-parent"></div>';

  console.group(...consoleMessage('Processing Screen Data'));
  console.log(htmlDocument);
  console.groupEnd();

  const mainContentDOM = htmlDocument.querySelector('#assistant-card-content');

   // Check if mainContentDOM exists before accessing innerHTML
  if (!mainContentDOM) {
      console.error("Could not find #assistant-card-content in screen data.");
      displayErrorScreen({ title: "Screen Data Error", details: "Could not process the response content." });
      return; // Exit if content is missing
  }


  mainArea.innerHTML = `
    <div class="assistant-markup-response fade-in-from-bottom">
      ${mainContentDOM.innerHTML}
    </div>`;

    // ... (resto del código de displayScreenData: theming, scaling, links, suggestions, history) ...
      if (theme === 'light' || getEffectiveTheme() === 'light') {
    const emojiRegex = /(?:[\u2700-\u27bf]|(?:\ud83c[\udde6-\uddff]){2}|[\ud800-\udbff][\udc00-\udfff]|[\u0023-\u0039]\ufe0f?\u20e3|\u3299|\u3297|\u303d|\u3030|\u24c2|\ud83c[\udd70-\udd71]|\ud83c[\udd7e-\udd7f]|\ud83c\udd8e|\ud83c[\udd91-\udd9a]|\ud83c[\udde6-\uddff]|[\ud83c[\ude01-\ude02]|\ud83c\ude1a|\ud83c\ude2f|[\ud83c[\ude32-\ude3a]|[\ud83c[\ude50-\ude51]|\u203c|\u2049|[\u25aa-\u25ab]|\u25b6|\u25c0|[\u25fb-\u25fe]|\u00a9|\u00ae|\u2122|\u2139|\ud83c\udc04|[\u2600-\u26FF]|\u2b05|\u2b06|\u2b07|\u2b1b|\u2b1c|\u2b50|\u2b55|\u231a|\u231b|\u2328|\u23cf|[\u23e9-\u23f3]|[\u23f8-\u23fa]|\ud83c\udccf|\u2934|\u2935|[\u2190-\u21ff])*/g;
    const assistantMarkupResponse = mainArea.querySelector(
      '.assistant-markup-response',
    );
    const emojis = assistantMarkupResponse.innerHTML
      .match(emojiRegex)
      ?.filter((x) => x); // Add optional chaining and check

    console.log('Emojis:', emojis);

    emojis?.forEach((emoji) => { // Add optional chaining
      assistantMarkupResponse.innerHTML = assistantMarkupResponse.innerHTML.replace(
        emoji,
        `<span style="filter: invert(1);">${emoji}</span>`,
      );
    });

    assistantMarkupResponse.classList.add('invert');
    assistantMarkupResponse.querySelectorAll('img').forEach((el) => {
      el.classList.add('invert');
    });
  }

  let element = mainArea.querySelector('.assistant-markup-response')
    ?.lastElementChild; // Add optional chaining

    // Check if element exists before proceeding
   if (!element) {
       console.warn("Could not find last element child in assistant markup response.");
       // Decide if you want to exit or continue gracefully
       // return;
   }


  const hasWebAnswer = mainArea.querySelector('#tv_web_answer_root');
  const hasKnowledgePanel = mainArea.querySelector('#tv_knowledge_panel_source');
  const hasCarousel = mainArea.querySelector('#selection-carousel-tv');
  const hasPhotoCarousel = mainArea.querySelector('#photo-carousel-tv');
  const hasTextContainer = element?.classList.contains('show_text_container'); // Optional chaining
  const hasPlainText = hasTextContainer && element?.querySelector('.show_text_content'); // Optional chaining
  const hasDefinition = mainArea.querySelector('#flex_text_audio_icon_chunk');
  const elementFlag = element?.getAttribute('data-flag'); // Optional chaining
  let isGoogleImagesContent;

  if (hasCarousel && !hasPhotoCarousel) {
    // Only when there is carousel other than "Photo Carousel"
    // Ensure lastElementChild exists before modifying
    const markupResponse = document.querySelector('.assistant-markup-response');
    if (markupResponse?.lastElementChild) {
       markupResponse.lastElementChild.innerHTML = hasCarousel.outerHTML;
    }
  }

  if (element && (elementFlag == null || elementFlag !== 'prevent-auto-scale')) { // Check element exists
    if (!hasPlainText) {
      if (assistantConfig['enableAutoScaling']) {
        element.setAttribute(
          'style',
          `
            transform: ${
              hasKnowledgePanel || hasWebAnswer ? 'scale(0.65)' : 'scale(0.75)'
            };
            position: relative;
            left: ${(() => {
              if (hasKnowledgePanel || hasWebAnswer) {
                return '-15%';
              }
              if (hasCarousel && !hasPhotoCarousel) {
                return '-91%';
              }
              if (hasPhotoCarousel) {
                return '-26%';
              }

              return '-10%';
            })()};
            top: ${(() => {
              if (hasKnowledgePanel) {
                return '-40px';
              }
              if (hasWebAnswer) {
                return '-35px';
              }
              if (hasDefinition) {
                return '-70px';
              }
              if (hasCarousel && !hasPhotoCarousel) {
                return '-45px';
              }

              return '-20px';
            })()};
            ${
              hasCarousel || hasPhotoCarousel
                ? 'overflow-x: scroll; width: 217%;'
                : ''
            }
            ${hasPhotoCarousel ? 'padding: 2em 0 0 0;' : ''}
          `,
        );
      }
    }
    else {
      element.setAttribute(
        'style',
        `
          transform: scale(1.2);
          position: relative;
          left: 13%;
          top: 60px;
        `,
      );
    }
  }

  // Ensure assistant-markup-response exists before adding class
  const markupResponseElement = mainArea.querySelector('.assistant-markup-response');
  if (markupResponseElement && (assistantConfig['enableAutoScaling'] || hasPlainText)) {
      markupResponseElement.classList.add('no-x-scroll');
  }


  if (hasDefinition) {
    hasDefinition.setAttribute(
      'onclick',
      "document.querySelector('audio')?.play()", // Optional chaining for audio element
    );

    hasDefinition.setAttribute('style', 'cursor: pointer;');
  }

  let existingStyle;

  if (element && (assistantConfig['enableAutoScaling'] || hasPlainText)) { // Check element exists
    while (element != null && !hasPhotoCarousel) {
      existingStyle = element.getAttribute('style');
      element.setAttribute(
        'style',
        `${existingStyle || ''}padding: 0;`,
      );
      element = element.lastElementChild;
    }
  }

  let responseType;

  if (hasTextContainer) {
    // Includes Text Response and Google Images Response

     // Ensure mainArea exists before modifying innerHTML
    if (mainArea) {
        mainArea.innerHTML = `
        <img src="../res/Google_Assistant_logo.svg" style="
            height: 25px;
            position: absolute;
            top: 20px;
            left: 20px;
        ">
        ${mainArea.innerHTML}
        `;
    }
  }

  if (hasPlainText) {
     const textContentElement = document.querySelector('.show_text_content');
     // Ensure textContentElement exists before accessing innerText
     const innerText = textContentElement ? textContentElement.innerText : '';
    responseType = inspectResponseType(innerText);

    const textContainer = document.querySelector('.show_text_container');

     // Ensure textContainer exists before modifying
    if (textContainer && responseType['type']) {
      if (
        responseType['type'] === 'google-search-result'
        || responseType['type'] === 'youtube-result'
      ) {
         // ... (código existente para search/youtube result) ...
      }
      else if (responseType['type'] === 'google-search-result-prompt') {
        activateLoader();

        try { // Wrap googleIt in try-catch
            const searchResults = await googleIt({
                query: getCurrentQuery(),
                'no-display': true,
            });

             // Check if searchResults exist and have at least one result
             if (searchResults && searchResults.length > 0) {
                 const topResult = searchResults[0];
                 // ... (código existente para mostrar resultado) ...
                  textContainer.innerHTML = googleSearchResultScreenData;
             } else {
                 console.warn("Google search returned no results for:", getCurrentQuery());
                 textContainer.innerHTML = "<p>Sorry, I couldn't find relevant search results.</p>";
             }

        } catch (searchError) {
            console.error("Error performing Google search:", searchError);
            textContainer.innerHTML = "<p>Sorry, there was an error searching Google.</p>";
        } finally {
             deactivateLoader();
        }

      }
    }

     // Check if innerText is available before checking for URL
    if (innerText && innerText.indexOf('https://www.google.com/search?tbm=isch') !== -1) {
      // Google Images (código existente)
      // ...
      // Asegurarse que los elementos existen antes de usarlos dentro del try/catch
      // ...
       const googleImagesCarousel = mainArea.querySelector(
          '#google-images-carousel',
       );
        if (!googleImagesCarousel) {
             console.error("Google Images carousel element not found.");
             // Handle error appropriately, maybe display a message
             return;
         }
        // ... resto del código de Google Images
    }
    else {
      isGoogleImagesContent = false;
    }
  }
  else {
    responseType = inspectResponseType('');
  }

  if (hasPhotoCarousel && element) { // Check element exists
    const images = element.querySelectorAll('img[data-src]');

    for (let i = 0; i < images.length; i++) {
      const img = images[i];
      img.setAttribute('src', img.getAttribute('data-src'));
    }
  }

  const externalLinks = mainArea.querySelectorAll('[data-url]');

  for (let i = 0; i < externalLinks.length; i++) {
    const temp = externalLinks[i];
    temp.setAttribute(
      'onclick',
      `openLink("${temp.getAttribute('data-url')}")`,
    );
    temp.setAttribute('style', 'cursor: pointer;');
  }

  // Set Suggestion Area
  const suggestionsDOM = htmlDocument.querySelector('#assistant-scroll-bar');
  const suggestionParent = document.querySelector('.suggestion-parent');

    // Ensure suggestionParent exists before modifying
  if (suggestionParent) {
      if (suggestionsDOM != null || responseType['type'] === 'google-search-result-prompt') {
           // ... (código existente para añadir botones de búsqueda/imágenes/fotos) ...

          if (responseType['type'] || hasWebAnswer || hasKnowledgePanel) { /* ... */ }
          if (isGoogleImagesContent) { /* ... */ }
          if (hasPhotoCarousel) { /* ... */ }

          for (let i = 0; i < suggestionsDOM?.children.length; i++) { // Optional chaining
              // ... (código existente para añadir sugerencias) ...
          }
      } else {
          suggestionParent.innerHTML = `
          <span style="opacity: 0.502;">
              ${supportedLanguages[assistantConfig['language']]?.noSuggestionsText || 'No suggestions available.'}
          </span>
          `;
      }
  }


  // Register horizontal scrolling for suggestion area
  registerHorizontalScroll(suggestionArea);

  // Apply horizontal scrolling behavior for carousels
  // ... (código existente para carousels) ...


  // Push to History
  if (pushToHistory && mainArea.querySelector('.error-area') == null) {
      // ... (código existente para push to history) ...
  }

  if (isGoogleImagesContent && getEffectiveTheme() === 'light') {
    seekHistory(historyHead);
  }
}

/**
 * Generates a screen data object from current screen.
 *
 * @param {boolean} includePreventAutoScaleFlag
 * Include "prevent-auto-scale" flag to the last element
 * of main content. _(Defaults to `false`)_
 *
 * @returns Generated screen data
 */
function generateScreenData(includePreventAutoScaleFlag = false) {
  const assistantMarkupResponse = document.querySelector('.assistant-markup-response');
   // Check if the element exists
  if (!assistantMarkupResponse) {
    console.error("Cannot generate screen data: .assistant-markup-response not found.");
    // Return a default or empty screen data object
    return { format: 'HTML', data: Buffer.from('<html><body>Error generating screen data</body></html>', 'utf-8') };
  }


  if (includePreventAutoScaleFlag && assistantMarkupResponse.lastElementChild) { // Check lastElementChild exists
    assistantMarkupResponse.lastElementChild.setAttribute(
      'data-flag',
      'prevent-auto-scale',
    );
  }

  const screenDataMainContent = `
    <div id="assistant-card-content">
      ${assistantMarkupResponse.innerHTML}
    </div>
  `;

  const suggestionParent = document.querySelector('.suggestion-parent');
  // Check if suggestionParent exists
  const suggestions = suggestionParent ? suggestionParent.children : [];
  let suggestionsDOM = '';

  if (suggestions.length > 0 && suggestions[0]?.classList.contains('suggestion')) { // Optional chaining for classList
    for (let i = 0; i < suggestions.length; i++) {
      const flag = suggestions[i].getAttribute('data-flag');
      const flagAttrib = flag ? `data-flag="${flag}"` : '';
      const label = suggestions[i].innerHTML.trim();
      const onclickAttr = suggestions[i].getAttribute('onclick'); // Get onclick attribute

       // Ensure onclickAttr exists and try to extract query
       let followUpQuery = '';
       if (onclickAttr) {
           const match = onclickAttr.match(/assistantTextQuery\(`(.*)`\)/);
           followUpQuery = match ? match[1] : onclickAttr; // Fallback to full onclick if regex fails
       }


      suggestionsDOM += `
      <button data-follow-up-query="${escapeQuotes(followUpQuery)}" ${flagAttrib}> <!-- Escape query -->
        ${label}
      </button>
      `;
    }
  }

  const screenDataSuggestionsHTML = `
    <div id="assistant-scroll-bar">
      ${suggestionsDOM}
    </div>
  `;

  const finalMarkup = [
    '<html><body>',
    screenDataMainContent,
    screenDataSuggestionsHTML,
    '</body></html>',
  ].join('');

  const screenData = { format: 'HTML', data: Buffer.from(finalMarkup, 'utf-8') };
  return screenData;
}

/**
 * Horizontally scrolls given element, `el`
 *
 * @param {Event} e
 * Scroll Event
 *
 * @param {HTMLElement} el
 * Element to be scrolled horizontally
 *
 * @param {boolean} smoothScroll
 * Whether to set `scrollBehavior` to "smooth"
 */
function scrollHorizontally(e, el, smoothScroll) {
  // Does not accept trackpad horizontal scroll
  if (e.wheelDeltaX === 0) {
    const delta = Math.max(-1, Math.min(1, e.wheelDelta || -e.detail));
    const scrollBehavior = smoothScroll ? 'smooth' : 'auto';
    const scrollOffset = 125;

    el.scrollBy({
      left: -(delta * scrollOffset),
      behavior: scrollBehavior,
    });
    e.preventDefault();
  }
}

/**
 * Registers horizontal scroll to given element
 * when mouse wheel event is triggered
 *
 * @param {HTMLElement} element
 * Element to be applied upon
 *
 * @param {boolean} smoothScroll
 * Whether to set `scrollBehavior` to "smooth"
 */
function registerHorizontalScroll(element, smoothScroll = true) {
  if (element) {
    // eslint-disable-next-line no-param-reassign
    element.onmousewheel = (e) => {
      scrollHorizontally(e, element, smoothScroll);
    };
  }
}

/**
 * Position the Assistant Window in bottom-center of the screen.
 */
function setAssistantWindowPosition() {
  ipcRenderer.send('set-assistant-window-position');
}

/**
 * Sets the window border based on config.
 */
function setAssistantWindowBorder() {
  const validBorders = ['none', 'prominent', 'minimal', 'color-shift'];

  const windowBorderValue = validBorders.includes(assistantConfig['windowBorder'])
    ? assistantConfig['windowBorder']
    : 'none';

  document
    .querySelector('#master-bg')
    ?.setAttribute('data-border', windowBorderValue); // Optional chaining
}


/**
 * Toggle Expand/Collapse Assistant Window.
 *
 * @param {boolean?} shouldExpandWindow
 * Specify whether the window should be expanded.
 * Leave the parameter if the window should toggle
 * the size automatically.
 */
function toggleExpandWindow(shouldExpandWindow) {
  if (shouldExpandWindow != null) expanded = !shouldExpandWindow;

  // Ensure expandCollapseButton exists before setting attribute
  if (expandCollapseButton) {
    if (!expanded) {
      assistantWindow.setSize(screen.availWidth - 20, 450);
      expandCollapseButton.setAttribute('src', '../res/collapse_btn.svg'); // Change to 'collapse' icon after expanding
    }
    else {
      assistantWindow.setSize(1000, 420);
      expandCollapseButton.setAttribute('src', '../res/expand_btn.svg'); // Change to 'expand' icon after collapsing
    }
  } else {
      console.warn("Expand/collapse button not found.");
  }


  setAssistantWindowPosition();
  expanded = !expanded;
}

/**
 * Relaunch Google Assistant Window.
 *
 * @param {object} args
 * Arguments to be processed when assistant window relaunches
 *
 * @param {boolean} args.shouldStartMic
 * Should the assistant start mic when relaunched
 */
function relaunchAssistant(args = {
  shouldStartMic: false,
}) {
  ipcRenderer.send('relaunch-assistant', args);
  console.log('Sent request for relaunch...');
}

/**
 * Restarts session in fallback mode.
 */
function restartInFallbackMode() {
  ipcRenderer.send('restart-fallback');
  console.log('Sent request for restarting in fallback mode...');
}

/**
 * Restarts session in normal mode.
 */
function restartInNormalMode() {
  ipcRenderer.send('restart-normal');
  console.log('Sent request for restarting in normal mode...');
}

/**
 * Quits the application from tray.
 */
function quitApp() {
  ipcRenderer.send('quit-app');
}

/**
 * Displays `message` for short timespan near the `nav region`.
 *
 * @param {string} message
 * Message that you want to display
 *
 * @param {boolean} allowOnlyOneMessage
 * Show the message only when no other quick message is showing up.
 */
function displayQuickMessage(message, allowOnlyOneMessage = false) {
  const navRegion = document.querySelector('#nav-region');

  // Exit from function when window is not displayed
  if (!navRegion) return;

  // Show the message only when no other message is showing up.
  // If `allowOlyOneMessage` is `true`
  if (allowOnlyOneMessage && navRegion.querySelector('.quick-msg')) return;

  const elt = document.createElement('div');
  elt.innerHTML = message;

  navRegion.appendChild(elt);
  elt.className = 'quick-msg';
  setTimeout(() => {
      // Check if elt still exists before removing
      if (navRegion.contains(elt)) {
          navRegion.removeChild(elt);
      }
  }, 5000);
}

/**
 * Adds additional styles to the `inputElement`,
 * giving users visual cue if the input is invalid.
 *
 * @param {Element} inputElement
 * The target `input` DOM Element to apply the styles on
 *
 * @param {boolean} addShakeAnimation
 * Whether additional shaking animation should be applied to the `inputElement`.
 * _(Defaults to `false`)_
 *
 * @param scrollIntoView
 * Scrolls the element into view. _(Defaults to `true`)_
 */
function markInputAsInvalid(
  inputElement,
  addShakeAnimation = false,
  scrollIntoView = true,
) {
   // Ensure inputElement exists
   if (!inputElement) return;

  inputElement.classList.add(['input-err']);

  if (addShakeAnimation) {
    inputElement.classList.add(['shake']);
    setTimeout(() => inputElement.classList.remove(['shake']), 300);
  }

  if (scrollIntoView) {
    inputElement.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
}

/**
 * Revert the styles of `inputElement` if
 * it is already marked as invalid input.
 *
 * @param {Element} inputElement
 * The target `input` DOM Element
 */
function markInputAsValid(inputElement) {
  // Ensure inputElement exists
  if (!inputElement) return;
  inputElement.classList.remove(['input-err']);
}


/**
 * Checks the `inputElement` and returns `true` when the path
 * is valid and exists in the system. (Less critical if paths are optional)
 *
 * @param {Element} inputElement
 * The `input` DOM Element to be validated
 *
 * @param {boolean} addShakeAnimationOnError
 * Add animation to let the user know if the path does not exist.
 * _(Defaults to `false`)_
 *
 * @param {boolean} scrollIntoView
 * Scrolls the element into view when invalid. _(Defaults to `true`)_
 *
 * @param {boolean} trimSpaces
 * Trims leading and trailing spaces if any are present in the
 * path entered in `inputElement`. _(Defaults to `true`)_
 *
 * @returns {boolean}
 * Returns boolean value (true/false) based on the validity of path
 */
function validatePathInput(
  inputElement,
  addShakeAnimationOnError = false,
  scrollIntoView = true,
  trimSpaces = true,
) {
   // Ensure inputElement exists
   if (!inputElement) return false; // Or handle error

  const val = trimSpaces ? inputElement.value.trim() : inputElement.value;

    // --- MODIFICACIÓN: Considerar campo vacío como válido si es opcional ---
    if (val === '') {
         markInputAsValid(inputElement);
         return true; // Empty path might be acceptable now
    }
    // --- FIN MODIFICACIÓN ---


  if (val !== '' && !fs.existsSync(val)) {
    markInputAsInvalid(inputElement, addShakeAnimationOnError, scrollIntoView);
    return false;
  }

  markInputAsValid(inputElement);
  return true;
}

// --- MODIFICACIÓN: Reemplazar contenido de showGetTokenScreen ---
/**
 * Initiates the server authentication flow.
 * This function is called by the Google Assistant library when it needs authentication.
 *
 * @param {function} _oauthValidationCallback - (No longer directly used) Original callback from the library.
 * @param {string} _authUrl - (No longer directly used) Original auth URL from the library.
 */
function showGetTokenScreen(_oauthValidationCallback, _authUrl) {
  console.log(...consoleMessage("Authentication required by library, starting server auth flow..."));
  initScreenFlag = 0; // Mark that we are in an auth flow screen

  // Opcional: Mostrar una pantalla de "Redirigiendo al login..."
   mainArea.innerHTML = `
     <div class="fade-in-from-bottom" style="text-align: center; padding-top: 100px;">
       <div style="font-size: 24px; margin-bottom: 20px;">Redirecting to Login Server...</div>
       <div class="loader" style="margin: 0 auto;"></div> <!-- Opcional: un spinner -->
       <div style="margin-top: 30px; opacity: 0.7;">
           If the browser window doesn't open automatically, please check your pop-up blocker or contact support.
       </div>
     </div>
   `;
   suggestionArea.innerHTML = '<div class="suggestion-parent"></div>'; // Limpiar sugerencias

   // Llamar a la función de autenticación del servidor
   startServerAuth();

   // La lógica original que creaba la UI para pegar el código se elimina completamente.
}
// --- FIN MODIFICACIÓN ---


/**
 * Sets the initial screen.
 */
function setInitScreen() {
  // --- MODIFICACIÓN: Solo mostrar pantalla inicial si NO estamos en flujo de auth ---
   if (!initScreenFlag) {
       console.log("Skipping init screen because initScreenFlag is 0 (likely in auth flow).");
       return;
   }
  // --- FIN MODIFICACIÓN ---

   // --- MODIFICACIÓN: Verificar si se requiere login antes de mostrar pantalla inicial ---
   // (Esto es redundante si ya se hizo throw Error antes, pero como doble chequeo)
   const needsLogin = assistantConfig['keyFilePath'] === '' && localStorage.getItem('isLoggedIn') !== 'true';
   if (needsLogin && !document.querySelector('.error-area')) { // Evitar si ya hay error
       console.log("Init screen check: Needs login, showing login prompt instead.");
       showLoginRequiredScreen(); // Llama a una función que muestre el prompt de login
       return; // No mostrar la pantalla de bienvenida normal
   }
   // --- FIN MODIFICACIÓN ---

  mainArea.innerHTML = `
    <div class="init">
      <center id="assistant-logo-main-parent">
        <img id="assistant-logo-main" src="../res/Google_Assistant_logo.svg" alt="">
      </center>

      <div id="init-headline-parent">
        <div id="init-headline">
          ${supportedLanguages[assistantConfig['language']]?.welcomeMessage || 'Hi, how can I help?'}
        </div>
      </div>
    </div>
  `;

    // Ensure language and suggestions exist
   const langData = supportedLanguages[assistantConfig['language']];
   const suggestions = langData?.initSuggestions || [];


  suggestionArea.innerHTML = `
  <div class="suggestion-parent">
    ${suggestions.map((suggestionObj) => `
        <div
          class="suggestion"
          onclick="assistantTextQuery('${escapeQuotes(suggestionObj.query)}')" <!-- Escape query -->
        >
          ${suggestionObj.label}
        </div>
      `)
    .join('')}
  </div>`;

  initHeadline = document.querySelector('#init-headline');
  // Ensure assistantInput exists before setting placeholder
   if (assistantInput) {
       assistantInput.placeholder = langData?.inputPlaceholder || 'Type or speak your query...';
   }

}

// --- MODIFICACIÓN: Función auxiliar para mostrar pantalla de login ---
function showLoginRequiredScreen() {
     mainArea.innerHTML = `
       <div class="fade-in-from-bottom">
         <div style="margin: 30px 10px 8px 10px;">
           <div style="font-size: 30px; margin-top: 30px;">Login Required</div>
           <div style="font-size: 21px; opacity: 0.502;">Please login to use Google Assistant.</div>
         </div>
         <div class="no-auth-grid">
           <div class="no-auth-grid-icon"><img src="../res/auth.svg" alt="Auth" /></div>
           <div class="no-auth-grid-info"><div>Click the button below to login via the server.</div></div>
         </div>
       </div>
     `;
     const suggestionParent = document.querySelector('.suggestion-parent');
     suggestionParent.innerHTML = `
       <div class="suggestion" onclick="startServerAuth()">
         <span><img src="../res/login.svg" style="height: 15px; width: 15px; vertical-align: text-top; padding-right: 5px; ${getEffectiveTheme() === 'light' ? 'filter: invert(1);' : ''}"></span>
         Login with Server
       </div>
     `;
     if(assistantMicrophone) {
         assistantMicrophone.id = '';
         assistantMicrophone.classList.add('assistant-mic-disabled');
     }
     initScreenFlag = 0; // Marcar que estamos en pantalla de auth/login
}
// --- FIN MODIFICACIÓN ---


/**
 * Turns off mic and stops output stream of the audio player.
 * Typically called before the window is closed.
 */
function stopAudioAndMic() {
  if (mic) mic.stop();
  if (audPlayer) audPlayer.stop();
}

/**
 * Returns effective theme based on `assistantConfig.theme`.
 * If the theme is set to `"system"`, it returns
 * the system theme.
 *
 * @param {"dark" | "light" | "system"} theme
 * Get the effective theme for given theme
 * explicitly. Leave it blank to infer from
 * `assistantConfig.theme`
 *
 * @returns {string}
 * Effective theme based on config and system preferences
 */
function getEffectiveTheme(theme = null) {
  // eslint-disable-next-line no-underscore-dangle
  const _theme = theme || assistantConfig.theme;

  if (['light', 'dark'].includes(_theme)) {
    return _theme;
  }

  if (_theme === 'system') {
    if (window.matchMedia('(prefers-color-scheme: light)').matches) {
      return 'light';
    }
  }

  return 'dark';
}

/**
 * Sets the theme based on the given `theme`.
 *
 * @param {"dark" | "light" | "system"} theme
 * The theme which you want to switch to.
 * Ignore this parameter, if you want to set
 * the theme based on `assistantConfig.theme`
 *
 * @param {boolean} forceAssistantResponseThemeChange
 * Change theme for Assistant Response screen.
 * _(Defaults to `true`)_
 */
function setTheme(theme = null, forceAssistantResponseThemeChange = true) {
    // ... (código existente de setTheme) ...
     const effectiveTheme = getEffectiveTheme(theme || assistantConfig.theme);
     const themeLabel = effectiveTheme === 'light' ? 'light-theme' : 'dark-theme';

     Object.keys(themes[themeLabel]).forEach((cssVariable) => {
       document.documentElement.style.setProperty(
         cssVariable,
         themes[themeLabel][cssVariable],
       );
     });

     console.log(...consoleMessage(
       `Setting theme: ${effectiveTheme} (${assistantConfig.theme})`,
     ));

     if (
       forceAssistantResponseThemeChange
       && document.querySelector('.assistant-markup-response')
       && history[historyHead] // Check if history item exists
     ) {
       displayScreenData(history[historyHead]['screen-data']);
     }

      document
        .querySelector('#master-bg')
        ?.setAttribute('data-theme', effectiveTheme); // Optional chaining
}


/**
 * Returns the string content to display inside About Box
 */
function getAboutBoxContent() {
    // ... (código existente de getAboutBoxContent) ...
    return content;
}

/**
 * Display "About" Dialog Box.
 */
function showAboutBox() {
    // ... (código existente de showAboutBox) ...
}

/**
 * Display "Command Line Arguments" Dialog Box.
 */
function showArgsDialog() {
    // ... (código existente de showArgsDialog) ...
}

/**
 * Start the microphone for transcription and visualization.
 */
function startMic() {
   // --- MODIFICACIÓN: Verificar login antes de iniciar micro ---
   const isLoggedIn = localStorage.getItem('isLoggedIn') === 'true';
   if (!isLoggedIn) {
       console.warn("Cannot start microphone, user not logged in.");
       displayQuickMessage("Please login first.");
       showLoginRequiredScreen(); // Mostrar pantalla de login
       return;
   }
   // --- FIN MODIFICACIÓN ---

    // --- MODIFICACIÓN: Verificar si el asistente está listo ---
    if (!isAssistantReady) {
        console.warn("Cannot start microphone, assistant not ready yet.");
        displayQuickMessage("Assistant is not ready yet.");
        return;
    }
    // --- FIN MODIFICACIÓN ---

  if (assistantConfig['respondToHotword']) {
    // Disable hotword detection when assistant is listening
    hotwordDetector?.stop();
  }

  if (canAccessMicrophone) {
    if (!mic) mic = new Microphone();
     mic.start(); // Mover mic.start() aquí, después de las comprobaciones
  }
  else {
    if(audPlayer) audPlayer.playPingStop(); // Check audPlayer exists
    stopMic();
    displayQuickMessage('Microphone is not accessible', true);
    return;
  }

  if (config.conversation['textQuery'] !== undefined) {
    delete config.conversation['textQuery'];
  }

  // Prevent triggering microphone when assistant
  // has not been initialized. (Doble chequeo)
  if (!isAssistantReady) return;

  // Iniciar conversación con el asistente
  if (assistant) { // Check assistant exists
      assistant.start(config.conversation);
  } else {
      console.error("Cannot start conversation: Assistant object not initialized.");
  }

}

/**
 * Stops the microphone for transcription and visualization.
 */
function stopMic() {
  if (assistantConfig['respondToHotword']) {
    // Enable hotword detection when assistant has done listening
    hotwordDetector?.start();
  }

  console.log('STOPPING MICROPHONE...');
  if (mic) mic.stop();
  if (p5jsMic) p5jsMic.stop(); // Check p5jsMic exists

  if (initHeadline) {
    initHeadline.innerText = supportedLanguages[assistantConfig['language']]?.welcomeMessage || 'Hi, how can I help?'; // Check language exists
  }

  // Set the `Assistant Mic` icon
  const assistantMicrophoneParent = document.querySelector('#assistant-mic-parent');
   // Ensure parent and icon exist before modification
  if (assistantMicrophoneParent) {
      assistantMicrophoneParent.outerHTML = `
        <div id="assistant-mic-parent" class="fade-scale">
            <img id="assistant-mic" src="../res/Google_mic.svg" type="icon" alt="Speak">
        </div>
      `;

      // Re-assign event listener to the new mic icon
      assistantMicrophone = document.querySelector('#assistant-mic');
      if (assistantMicrophone) {
          assistantMicrophone.onclick = startMic;
      }
  }

}

/**
 * Callback function called when the application
 * requests to close the window when out of focus.
 */
function closeOnBlurCallback() {
  const isDevToolsFocused = assistantWindow.webContents.isDevToolsFocused();
  const isCloseOnBlurAllowed = ipcRenderer.sendSync('get-allow-close-on-blur');

  // Only close when not focusing DevTools and
  // the application is initialized properly
  if (!isDevToolsFocused && initScreenFlag && isCloseOnBlurAllowed) {
    stopAudioAndMic();
    close();
  }

  // Reset `allowCloseOnBlur` if already set to `false`
  ipcRenderer.sendSync('set-allow-close-on-blur', true);
}

/**
 * Checks if the application is running in fallback mode.
 * Typically enabled when user requests the app to start
 * with settings set to default.
 */
function isFallbackMode() {
  return process.env.FALLBACK_MODE === 'true';
}

/**
 * Returns an object containing `commitHash` and `commitDate`
 * of the latest commit.
 *
 * (**Requires GIT**)
 */
function getCommitInfo() {
    // ... (código existente de getCommitInfo) ...
    return { commitHash, commitDate };
}

/**
 * Returns a version string with a `v` prefixed.
 *
 * If the `version` provided is empty, current version
 * of the application is returned.
 *
 * @param {string} version
 * Version
 */
function getVersion(version) {
  const appVersion = version || app.getVersion();
  const ver = `v${appVersion.replace(/^v*/, '')}`;

  return ver;
}

/**
 * Returns help for granting microphone permission as an
 * HTML string.
 */
function getMicPermEnableHelp() {
    // ... (código existente de getMicPermEnableHelp) ...
    return `You can ${defaultMsg.replace(/^M/, 'm')}`;
}

// --- MODIFICACIÓN: Quitar función resetSavedTokensFile ---
/**
 * (DEPRECATED/REMOVED) Deletes the saved tokens file forcing the Get Tokens
 * screen on next start. This is likely not needed with server auth.
 */
/*
function resetSavedTokensFile(showRelaunchScreen = true, showWarning = true) {
    // ... (código original eliminado) ...
    console.warn("resetSavedTokensFile is likely deprecated with server auth.");
    // Consider clearing localStorage state instead if needed:
    // localStorage.removeItem('isLoggedIn');
    // displayQuickMessage("Local login state cleared. Please login again.");
    // startServerAuth(); // Or relaunchAssistant();
}
*/
// --- FIN MODIFICACIÓN ---

/**
 * Returns a formatted message to be logged in console
 * prefixed with a type.
 *
 * @param {string} message
 * The message to be logged in the console
 *
 * @param {"info" | "error" | "warn"} type
 * Type of the message
 *
 * @returns {string[]}
 * List of strings with formatting to be printed in console.
 * Use `...` operator to unpack the list as parameters to the
 * console function.
 *
 * @example <caption>Passing to `console.log`</caption>
 * console.log(...consoleMessage('This is an info', 'info'));
 *
 * @example <caption>Passing to `console.group`</caption>
 * console.group(...consoleMessage('This is an error', 'error'));
 * console.error(error);
 * console.groupEnd();
 */
function consoleMessage(message, type = 'info') {
    // ... (código existente de consoleMessage) ...
    return [ /* ... */ ];
}

/**
 * Maps the value `n` which ranges between `start1` and `stop1`
 * to `start2` and `stop2`.
 *
 * @param {number} n
 * @param {number} start1
 * @param {number} stop1
 * @param {number} start2
 * @param {number} stop2
 */
function map(n, start1, stop1, start2, stop2) {
  return ((n - start1) / (stop1 - start1)) * (stop2 - start2) + start2;
}

/**
 * Constrain `n` between `high` and `low`
 *
 * @param {number} n
 * @param {number} low
 * @param {number} high
 */
function constrain(n, low, high) {
  if (n < low) return low;
  if (n > high) return high;

  return n;
}

// --- Event Listeners (código existente con chequeos añadidos) ---

if (assistantMicrophone) assistantMicrophone.onclick = startMic;

if (assistantInput) {
    assistantInput.addEventListener('keyup', (event) => {
        if (event.keyCode === 13) {
            assistantTextQuery(assistantInput.value);
        }
    });

    assistantInput.onkeydown = (e) => {
        switch (e.key) {
            case 'ArrowUp':
                 // Ensure history exists and queryHistoryHead is valid
                if (history && history.length > 0 && queryHistoryHead > 0) {
                    queryHistoryHead--;
                     // Check if history item and query exist
                    assistantInput.value = history[queryHistoryHead]?.query || '';
                }
                break;
            case 'ArrowDown':
                 // Ensure history exists
                if (history && queryHistoryHead <= history.length - 1) {
                    queryHistoryHead++;
                    if (queryHistoryHead === history.length) {
                        assistantInput.value = currentTypedQuery;
                    } else {
                         // Check if history item and query exist
                        assistantInput.value = history[queryHistoryHead]?.query || '';
                    }
                }
                break;
            default:
                // no-op
        }
    };

    assistantInput.oninput = (e) => {
        if (mic?.isActive) stopMic(); // Optional chaining for mic
        queryHistoryHead = history.length;
        currentTypedQuery = e.target.value;
    };
}


// Set Initial Screen Logic
// --- MODIFICACIÓN: Mover la lógica de inicialización aquí después de definir funciones ---
try {
  document.querySelector('#init-loading').style.opacity = 0;

  setTimeout(() => {
    setInitScreen(); // Llama a la función actualizada

    // --- MODIFICACIÓN: Condicionar startMic al estado de login ---
    const isLoggedIn = localStorage.getItem('isLoggedIn') === 'true';
    if (
      isLoggedIn && // Solo si está logueado
      (assistantConfig.enableMicOnStartup || assistantWindowLaunchArgs.shouldStartMic) &&
      !firstLaunch &&
      initScreenFlag // Y no estamos en pantalla de auth
    ) {
      startMic();
    } else if (!isLoggedIn && initScreenFlag) {
         console.log("Initial mic start skipped: User not logged in.");
         // No iniciar micro, setInitScreen ya debería haber mostrado el login si era necesario
    }
    // --- FIN MODIFICACIÓN ---

  }, 200); // Delay como antes

} catch (e) {
    // Capturar errores durante la inicialización temprana (ej. First Time User, Auth Required)
    console.warn("Initial setup halted:", e.message);
    // La UI ya debería haberse configurado por el código que lanzó el error.
    // Asegurarse que el loading se oculte si no lo hizo antes
    const loadingElement = document.querySelector('#init-loading');
    if(loadingElement) loadingElement.style.opacity = 0;
}
// --- FIN MODIFICACIÓN ---


// Auto-focus Assistant Input box when '/' is pressed
window.onkeypress = (e) => {
  if (e.key === '/') {
     // Ensure assistantInput exists
    if (assistantInput && document.activeElement !== assistantInput && document.activeElement?.tagName !== 'INPUT') {
      e.preventDefault();
      assistantInput.focus();
    }
  }
};


window.onkeydown = (e) => {
  if (document.querySelector('#config-screen')) {
     const hotkeyBar = document.querySelector('#hotkey-div');
     // Check if hotkeyBar exists before accessing classList
     if (hotkeyBar?.classList.contains('input-active')) {
       return;
     }
  }

  if (e.key === 'Escape') {
    if (assistantConfig['escapeKeyBehavior'] === 'minimize') {
      minimizeWindow();
    }
    else if (assistantConfig['escapeKeyBehavior'] === 'close') {
      stopAudioAndMic();
      close();
    }
  }
};

// Change theme when system theme changes
window.matchMedia('(prefers-color-scheme: light)').onchange = (e) => {
  if (assistantConfig.theme === 'system') {
    if (e.matches) {
      setTheme('light');
    }
    else {
      setTheme('dark');
    }
  }
};

// Listen for 'mic start' request from main process
ipcRenderer.on('request-mic-toggle', () => {
   // Check mic exists before accessing isActive
  if (mic?.isActive) {
    if (audPlayer) audPlayer.playPingStop(); // Check audPlayer exists
    stopMic();
  }
  else {
    startMic();
  }
});

// Stop mic and audio before closing window from main process.
ipcRenderer.on('window-will-close', () => {
  stopAudioAndMic();
});