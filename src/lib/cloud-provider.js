import log from './log.js';

const CLOUD_PREFIX = '\u2601 ';

class CloudProvider {
    /**
     * A cloud data provider which creates and manages a web socket connection
     * to the Scratch cloud data server. This provider is responsible for
     * interfacing with the VM's cloud io device.
     * @param {VirtualMachine} vm The Scratch virtual machine to interface with
     * @param {string} username The username to associate cloud data updates with
     * @param {string} projectId The id associated with the project containing
     * cloud data.
     * @param {boolean} special Whether to use special cloud behaviours (for
     * compatibility with the HTMLifier).
     * @param {?string} cloudHost The url for the cloud data server
     */
    constructor (vm, username, projectId, special, cloudHost) {
        this.vm = vm;
        this.username = username;
        this.projectId = projectId;
        this.special = special;
        this.cloudHost = cloudHost;

        this.connectionAttempts = 0;

        // A queue of messages to send which were received before the
        // connection was ready
        this.queuedData = [];

        this._onStorage = this._onStorage.bind(this);
        this._onLoad = this._onLoad.bind(this);
        this._onUrlChange = this._onUrlChange.bind(this);
        this._onPaste = this._onPaste.bind(this);
        this._postError = this._postError.bind(this);

        if (special || !cloudHost) {
            window.addEventListener('storage', this._onStorage);
            vm.runtime.on('PROJECT_LOADED', this._onLoad);
        }

        if (cloudHost) {
            this._openConnection();
        } else {
            this.connection = true;
        }

        if (special) {
            window.addEventListener('hashchange', this._onUrlChange);
            window.addEventListener('popstate', this._onUrlChange);
            window.addEventListener('paste', this._onPaste);
        }
    }

    _onStorage (event) {
        if (event.storageArea === localStorage && event.key.slice(0, 5) === '[s3] ') {
            this.vm.postIOData('cloud', {
                varUpdate: {
                    name: event.key.slice(5),
                    value: event.newValue
                }
            });
        }
    }

    _onLoad () {
        const stageVariables = this.vm.runtime.getTargetForStage().variables;
        for (const { name, isCloud } of Object.values(stageVariables)) {
            if (isCloud) {
                if (this.cloudHost && !name.startsWith(CLOUD_PREFIX + 'local storage')) continue;
                const value = localStorage.getItem('[s3] ' + name);
                if (value === null) continue;
                this.vm.postIOData('cloud', { varUpdate: { name, value } });
            }
        }
        this._onUrlChange();
    }

    _onUrlChange () {
        this.vm.postIOData('cloud', {
            varUpdate: {
                name: CLOUD_PREFIX + 'url',
                value: window.location.href
            }
        });
    }

    _onPaste (event) {
        this.vm.postIOData('cloud', {
            varUpdate: {
                name: CLOUD_PREFIX + 'pasted',
                value: (event.clipboardData || window.clipboardData).getData('text')
            }
        });
    }

    /**
     * Open a new websocket connection to the clouddata server.
     */
    _openConnection () {
        this.connectionAttempts += 1;

        try {
            this.connection = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + this.cloudHost);
        } catch (e) {
            log.warn('Websocket support is not available in this browser', e);
            this.connection = null;
            return;
        }

        this.connection.onerror = this._onError.bind(this);
        this.connection.onmessage = this._onMessage.bind(this);
        this.connection.onopen = this._onOpen.bind(this);
        this.connection.onclose = this._onClose.bind(this);
    }

    _onError (event) {
        log.error(`Websocket connection error: ${JSON.stringify(event)}`);
        // Error is always followed by close, which handles reconnect logic.
    }

    _onMessage (event) {
        const messageString = event.data;
        // Multiple commands can be received, newline separated
        messageString.split('\n').forEach(message => {
            if (message) { // .split can also contain '' in the array it returns
                const parsedData = this._parseMessage(JSON.parse(message));
                this.vm.postIOData('cloud', parsedData);
            }
        });
    }

    _onOpen () {
        // Reset connection attempts to 1 to make sure any subsequent reconnects
        // use connectionAttempts=1 to calculate timeout
        this.connectionAttempts = 1;
        this._writeToServer('handshake');
        log.info(`Successfully connected to clouddata server.`);

        // Go through the queued data and send off messages that we weren't
        // ready to send before
        this.queuedData.forEach(data => {
            this._sendCloudData(data);
        });
        // Reset the queue
        this.queuedData = [];
    }

    _onClose () {
        log.info(`Closed connection to websocket`);
        const randomizedTimeout = this._randomizeDuration(this._exponentialTimeout());
        this._setTimeout(this._openConnection.bind(this), randomizedTimeout);
    }

    _exponentialTimeout () {
        return (Math.pow(2, Math.min(this.connectionAttempts, 5)) - 1) * 1000;
    }

    _randomizeDuration (t) {
        return Math.random() * t;
    }

    _setTimeout (fn, time) {
        log.info(`Reconnecting in ${(time / 1000).toFixed(1)}s, attempt ${this.connectionAttempts}`);
        this._connectionTimeout = window.setTimeout(fn, time);
    }

    _parseMessage (message) {
        const varData = {};
        switch (message.method) {
        case 'set': {
            varData.varUpdate = {
                name: message.name,
                value: message.value
            };
            break;
        }
        }
        return varData;
    }

    /**
     * Format and send a message to the cloud data server.
     * @param {string} methodName The message method, indicating the action to perform.
     * @param {string} dataName The name of the cloud variable this message pertains to
     * @param {string | number} dataValue The value to set the cloud variable to
     * @param {string} dataNewName The new name for the cloud variable (if renaming)
     */
    _writeToServer (methodName, dataName, dataValue, dataNewName) {
        const msg = {};
        msg.method = methodName;
        msg.user = this.username;
        msg.project_id = this.projectId;

        // Optional string params can use simple falsey undefined check
        if (dataName) msg.name = dataName;
        if (dataNewName) msg.new_name = dataNewName;

        // Optional number params need different undefined check
        if (typeof dataValue !== 'undefined' && dataValue !== null) msg.value = dataValue;

        const dataToWrite = JSON.stringify(msg);
        if (!this.cloudHost || this.connection && this.connection.readyState === WebSocket.OPEN) {
            this._sendCloudData(dataToWrite);
        } else if (msg.method === 'create' || msg.method === 'delete' || msg.method === 'rename') {
            // Save data for sending when connection is open, iff the data
            // is a create, rename, or  delete
            this.queuedData.push(dataToWrite);
        }

    }

    _postError (error) {
        this.vm.postIOData('cloud', {
            varUpdate: {
                name: CLOUD_PREFIX + 'eval error',
                value: error.toString()
            }
        });
    }

    /**
     * Send a formatted message to the cloud data server.
     * @param {string} data The formatted message to send.
     */
    _sendCloudData (data) {
        const message = JSON.parse(data);
        if (this.special) {
            if (message.method === 'set') {
                const {name, value} = message
                switch (name.replace(CLOUD_PREFIX, '')) {
                    case 'eval':
                        try {
                            Promise.resolve(eval(value))
                                .then(output => {
                                    this.vm.postIOData('cloud', {
                                        varUpdate: {
                                            name: CLOUD_PREFIX + 'eval output',
                                            value: output
                                        }
                                    });
                                })
                                .catch(this._postError);
                        } catch (error) {
                            this._postError(error);
                        }
                        return;
                    case 'open link':
                        try {
                            window.open(value, '_blank');
                        } catch (error) {
                            this._postError(error);
                        }
                        return;
                    case 'redirect':
                        window.location = value;
                        return;
                    case 'set clipboard':
                        try {
                            navigator.clipboard.writeText(value).catch(this._postError);
                        } catch (error) {
                            this._postError(error);
                        }
                        return;
                    case 'set server ip':
                        this.cloudHost = value;
                        if (this.connection) {
                            this.connection.onclose = () => {};
                            this.connection.onerror = () => {};
                            this.connection.close();
                        }
                        this._openConnection();
                        return;
                    case 'username':
                        this.vm.postIOData('userData', {username: value});
                        return;
                }
            }
        }
        if (
            !this.cloudHost ||
            this.special && (
                message.name.startsWith(CLOUD_PREFIX + 'local storage') ||
                message.method === 'rename' &&
                    message.new_name.startsWith(CLOUD_PREFIX + 'local storage'))
        ) {
            switch (message.method) {
            case 'create':
            case 'set': {
                localStorage.setItem('[s3] ' + message.name, message.value);
                break;
            }
            case 'rename': {
                const value = localStorage.getItem('[s3] ' + message.name);
                localStorage.removeItem('[s3] ' + message.name);
                localStorage.setItem('[s3] ' + message.new_name, value);
                break;
            }
            case 'delete': {
                localStorage.removeItem('[s3] ' + message.name);
                break;
            }
            }
        } else {
            this.connection.send(`${data}\n`);
        }
    }

    /**
     * Provides an API for the VM's cloud IO device to create
     * a new cloud variable on the server.
     * @param {string} name The name of the variable to create
     * @param {string | number} value The value of the new cloud variable.
     */
    createVariable (name, value) {
        this._writeToServer('create', name, value);
    }

    /**
     * Provides an API for the VM's cloud IO device to update
     * a cloud variable on the server.
     * @param {string} name The name of the variable to update
     * @param {string | number} value The new value for the variable
     */
    updateVariable (name, value) {
        this._writeToServer('set', name, value);
    }

    /**
     * Provides an API for the VM's cloud IO device to rename
     * a cloud variable on the server.
     * @param {string} oldName The old name of the variable to rename
     * @param {string} newName The new name for the cloud variable.
     */
    renameVariable (oldName, newName) {
        this._writeToServer('rename', oldName, null, newName);
    }

    /**
     * Provides an API for the VM's cloud IO device to delete
     * a cloud variable on the server.
     * @param {string} name The name of the variable to delete
     */
    deleteVariable (name) {
        this._writeToServer('delete', name);
    }

    /**
     * Closes the connection to the web socket and clears the cloud
     * provider of references related to the cloud data project.
     */
    requestCloseConnection () {
        if (this.special || !this.cloudHost) {
            window.removeEventListener('storage', this._onStorage);
            vm.runtime.off('PROJECT_LOADED', this._onLoad);
        }
        if (this.connection &&
            this.connection.readyState !== WebSocket.CLOSING &&
            this.connection.readyState !== WebSocket.CLOSED) {
            log.info('Request close cloud connection without reconnecting');
            // Remove listeners, after this point we do not want to react to connection updates
            this.connection.onclose = () => {};
            this.connection.onerror = () => {};
            this.connection.close();
        }
        if (this.special) {
            window.removeEventListener('hashchange', this._onUrlChange);
            window.removeEventListener('popstate', this._onUrlChange);
            window.removeEventListener('paste', this._onPaste);
        }
        this.clear();
    }

    /**
     * Clear this provider of references related to the project
     * and current state.
     */
    clear () {
        this.connection = null;
        this.vm = null;
        this.username = null;
        this.projectId = null;
        if (this._connectionTimeout) {
            clearTimeout(this._connectionTimeout);
            this._connectionTimeout = null;
        }
        this.connectionAttempts = 0;
    }

}

export default CloudProvider;
