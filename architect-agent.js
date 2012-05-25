var EventEmitter = require('events').EventEmitter;
var inherits = require('util').inherits;
var msgpack = require('msgpack-js');

exports.Agent = Agent;
exports.Transport = Transport;
exports.Remote = Remote;
exports.deFramer = deFramer;
exports.liven = liven;
exports.freeze = freeze;
exports.getType = getType;

////////////////////////////////////////////////////////////////////////////////

// Agent is an API serving node in the architect-agent rpc mesh.  It contains
// the functions that actually do the work.
// @api - a persistent object that holds the API functions
// @connect(transport, callback) - A method that connects to a remote agent via
//                                 a Transport instance.
function Agent(api) {
  if (!this instanceof Agent) throw new Error("Forgot to use new with Agent constructor");
  this.api = api || {};
}
inherits(Agent, EventEmitter);

// Time to wait for remote connections to finish
Agent.prototype.connectionTimeout = 10000;

// Connect to a remote Agent via a transport.  Callback on connection, error,
// or timeout.
Agent.prototype.connect = function (transport, callback) {
  var remote = new Remote(this);
  remote.connect(transport);

  // Start event listeners
  remote.on("connect", onConnect);
  remote.on("error", onError);
  var timeout = setTimeout(onTimeout, this.connectionTimeout);

  function onConnect() {
    reset();
    callback(null, remote);
  }
  function onError(err) {
    reset();
    callback(err);
  }
  function onTimeout() {
    reset();
    callback(new Error("Timeout while waiting for remote agent to connect."));
  }
  // Only one event should happen, so stop event listeners on first event.
  function reset() {
    remote.removeListener("connect", onConnect);
    remote.removeListener("error", onError);
    clearTimeout(timeout);
  }
};

////////////////////////////////////////////////////////////////////////////////

// Transport is a connection between two Agents.  It lives on top of a duplex,
// binary stream.
// @input - the stream we listen for data on
// @output - the stream we write to (can be the same object as input)
// @send(message) - send a message to the other side
// "message" - event emitted when we get a message from the other side.
// "error" - event emitted for stream error or disconnect
// "drain" - drain event from output stream
function Transport(input, output) {
    var self = this;
    if (arguments.length === 1) output = input;
    this.input = input;
    this.output = output;

    if (!input.readable) throw new Error("Input is not readable");
    if (!output.writable) throw new Error("Output is not writable");

    // Attach event listeners
    input.on("data", onData);
    input.on("end", onDisconnect);
    input.on("timeout", onDisconnect);
    input.on("close", onDisconnect);
    input.on("error", onError);
    output.on("drain", onDrain);
    if (output !== input) {
        output.on("end", onDisconnect);
        output.on("timeout", onDisconnect);
        output.on("close", onDisconnect);
        output.on("error", onError);
    }

    var parse = deFramer(function (frame) {
        var message;
        try {
            message = msgpack.decode(frame);
        } catch (err) {
            return self.emit("error", err);
        }
        self.emit("message", message);
    });

    // Route data chunks to the parser, but check for errors
    function onData(chunk) {
        try {
            parse(chunk);
        } catch (err) {
            self.emit("error", err);
        }
    }

    // Forward drain events from the writable stream
    function onDrain() {
        self.emit("drain");
    }
    // Forward all error events to the transport
    function onError(err) {
        self.emit("error", err);
    }
    function onDisconnect() {
        // Remove all the listeners we added and destroy the streams
        input.removeListener("data", onData);
        input.removeListener("end", onDisconnect);
        input.removeListener("timeout", onDisconnect);
        input.removeListener("close", onDisconnect);
        output.removeListener("drain", onDrain);
        input.destroy();
        if (input !== output) {
            output.removeListener("end", onDisconnect);
            output.removeListener("timeout", onDisconnect);
            output.removeListener("close", onDisconnect);
            output.destroy();
        }
        // Emit the disconnect as an error
        var err = new Error("EDISCONNECT: Transport disconnected");
        err.code = "EDISCONNECT";
        self.emit("error", err);
    }
}
inherits(Transport, EventEmitter);

Transport.prototype.send = function (message) {
    // Serialize the messsage.
    var frame = msgpack.encode(message);

    // Send a 4 byte length header before the frame.
    var header = new Buffer(4);
    header.writeUInt32BE(frame.length, 0);
    this.output.write(header);

    // Send the serialized message.
    return this.output.write(frame);
};

// A simple state machine that consumes raw bytes and emits message events.
// Returns a parser function that consumes buffers.  It emits message buffers
// via onMessage callback passed in.
function deFramer(onFrame) {
    var buffer;
    var state = 0;
    var length = 0;
    var offset;
    return function parse(chunk) {
        for (var i = 0, l = chunk.length; i < l; i++) {
            switch (state) {
            case 0: length |= chunk[i] << 24; state = 1; ; break;
            case 1: length |= chunk[i] << 16; state = 2; break;
            case 2: length |= chunk[i] << 8; state = 3; break;
            case 3: length |= chunk[i]; state = 4;
                buffer = new Buffer(length);
                offset = 0;
                break;
            case 4:
                var len = l - i;
                var emit = false;
                if (len + offset >= length) {
                    emit = true;
                    len = length - offset;
                }
                // TODO: optimize for case where a copy isn't needed can a slice can
                // be used instead?
                chunk.copy(buffer, offset, i, i + len);
                offset += len;
                i += len - 1;
                if (emit) {
                    onFrame(buffer);
                    state = 0;
                    length = 0;
                    buffer = undefined;
                    offset = undefined;
                }
                break;
            }
        }
    };
};

////////////////////////////////////////////////////////////////////////////////

// Remote represents a local proxy of a remote Agent instance.  It can contain
// a single active Transport connection when it's live.
// @connect(transport) - Connect to a new remote Agent via transport
// @disconnect() - Disconnect from the remote agent
// "connect" - an event emitted when the connection is established
// "disconnect" - an event emitted when the connection goes down
// "drain" drain event from the output stream
function Remote(agent) {
    if (!this instanceof Remote) throw new Error("Forgot to use new with Remote constructor");

    this.agent = agent;

    // Bind event handlers and callbacks
    this.disconnect = this.disconnect.bind(this);
    this._onMessage = this._onMessage.bind(this);
    this._onDrain = this._onDrain.bind(this);
    this._onReady = this._onReady.bind(this);
    this._getFunction = this._getFunction.bind(this);
    this._storeFunction = this._storeFunction.bind(this);

    this.api = {}; // Persist the API object between connections
    this.transport = undefined;
    this.callbacks = undefined;
    this.nextKey = undefined;
}
inherits(Remote, EventEmitter);

Remote.prototype.connect = function (transport) {
    this.transport = transport;
    this.callbacks = {};
    this.nextKey = 1;
    transport.on("error", this.disconnect);
    transport.on("message", this._onMessage);
    transport.on("drain", this._onDrain);

    // Handshake with the other end
    this.send(["ready", this._onReady]);
};

Remote.prototype.send = function (message) {
    message = freeze(message, this._storeFunction);
    return this.transport.send(message);
}

Remote.prototype._onReady = function (names) {
    if (!Array.isArray(names)) {
        this.emit("error", names);
    }
    var self = this;
    names.forEach(function (name) {
        // Ignore already set functions so that existing function references
        // stay valid.
        if (self.api[name]) return;
        self.api[name] = function () {
            // When disconnected we can't forward the call.
            if (!self.transport) {
                var callback = arguments[arguments.length - 1];
                if (typeof callback === "function") {
                    var err = new Error("ENOTCONNECTED: Remote is offline, try again later");
                    err.code = "ENOTCONNECTED";
                    callback(err);
                }
                return;
            }
            var args = [name];
            args.push.apply(args, arguments);
            return self.send(args);
        };
    });
    this.emit("connect");
};

// Disconnect resets the state of the remote, flushes callbacks and emits a
// "disconnect" event with optional error object.
Remote.prototype.disconnect = function (err) {
    if (!this.transport) {
        return this.emit("error", err || new Error("Not connected"));
    }

    // Disconnect from transport
    this.transport.removeListener("error", this.disconnect);
    this.transport.removeListener("message", this._onMessage);
    this.transport.removeListener("drain", this._onDrain);
    this.transport = undefined;

    // Flush any callbacks
    if (this.callbacks) {
        var cerr = err;
        if (!cerr) {
            cerr = new Error("EDISCONNECT: Remote disconnected");
            cerr.code = "EDISCONNECT";
        }
        var callbacks = this.callbacks;
        this.callbacks = undefined;
        forEach(callbacks, function (callback) {
            callback(cerr);
        });
    }
    this.nextKey = undefined;

    this.emit("disconnect", err);
};

// Forward drain events
Remote.prototype._onDrain = function () {
    this.emit("drain");
};

// Route incoming messages to the right functions
Remote.prototype._onMessage = function (message) {
    // console.log(process.pid, message);
    if (!(Array.isArray(message) && message.length)) {
        return this.emit("error", new Error("Message should be an array"));
    }
    message = liven(message, this._getFunction);
    var id = message[0];
    var fn;
    if (id === "ready") {
        var keys = Object.keys(this.agent.api);
        fn = function (callback) {
            callback(keys);
        };
    }
    else {
        fn = typeof id === "string" ? this.agent.api[id] : this.callbacks[id];
    }
    if (!(typeof fn === "function")) {
        return this.emit("error",  new Error("Should be function"));
    }
    fn.apply(null, message.slice(1));
};

// Create a proxy function that calls fn key on the remote side.
// This is for when a remote passes a callback to a local function.
Remote.prototype._getFunction = function (key) {
    var transport = this.transport;
    return function () {
        // Call a remote function using [key, args...]
        var args = [key];
        // Push is actually fast http://jsperf.com/array-push-vs-concat-vs-unshift
        args.push.apply(args, arguments);
        return transport.send(args);
    };
};

// This is for when we call a remote function and pass in a callback
Remote.prototype._storeFunction = function (fn) {
    var key = this.nextKey;
    while (this.callbacks.hasOwnProperty(key)) {
        key = (key + 1) >> 0;
        if (key === this.nextKey) {
            throw new Error("Ran out of keys!!");
        }
    }
    this.nextKey = (key + 1) >> 0;;

    var callbacks = this.callbacks;
    var self = this;
    // Wrap is a self cleaning function and store in the index
    callbacks[key] = function () {
        delete callbacks[key];
        self.nextKey = key;
        return fn.apply(this, arguments);
    };
    return key;
};

// Convert a js object into a serializable object when functions are
// encountered, the storeFunction callback is called for each one.
// storeFunction takes in a function and returns a unique id number. Cycles
// are stored as object with a single $ key and an array of strigs as the
// path. Functions are stored as objects with a single $ key and id as value.
// props. properties starting with "$" have an extra $ prepended.
function freeze(value, storeFunction) {
    var seen = [];
    var paths = [];
    function find(value, path) {
        // find the type of the value
        var type = getType(value);
        // pass primitives through as-is
        if (type !== "function" && type !== "object" && type !== "array") {
            return value;
        }

        // Look for duplicates
        var index = seen.indexOf(value);
        if (index >= 0) {
            return { "$": paths[index] };
        }
        // If not seen, put it in the registry
        index = seen.length;
        seen[index] = value;
        paths[index] = path;

        var o;
        // Look for functions
        if (type === "function") {
            o = storeFunction(value);
        }

        if (o) return {$:o};

        // Recurse on objects and arrays
        return map(value, function (sub, key) {
            return find(sub, path.concat([key]));
        }, null, function (key) {
          return key[0] === "$" ? "$" + key : key;
        });
    }
    return find(value, []);
}

// Converts flat objects into live objects.  Cycles are re-connected and
// functions are inserted. The getFunction callback is called whenever a
// frozen function is encountered. It expects an ID and returns the function
function liven(message, getFunction) {
    function find(value, parent, key) {
        // find the type of the value
        var type = getType(value);

        // Unescape $$+ escaped keys
        if (key[0] === "$") key = key.substr(1);

        // pass primitives through as-is
        if (type !== "function" && type !== "object" && type !== "array") {
            parent[key] = value;
            return value;
        }

        // Load Specials
        if (value.hasOwnProperty("$")) {
            var special = value.$;
            // Load backreferences
            if (Array.isArray(special)) {
              parent[key] = get(obj.root, special);
              return parent[key];
            }
            // Load functions
            parent[key] = getFunction(special);
            return  parent[key];
        }

        // Recurse on objects and arrays
        var o = Array.isArray(value) ? [] : {};
        parent[key] = o;
        forEach(value, function (sub, key) {
            find(sub, o, key);
        });
        return obj;
    }
    var obj = {};
    find(message, obj, "root");
    return obj.root;
}

////////////////////////////////////////////////////////////////////////////////

// Typeof is broken in javascript, add support for null and buffer types
function getType(value) {
    if (value === null) {
        return "null";
    }
    if (Array.isArray(value)) {
        return "array";
    }
    if (typeof Buffer !== "undefined" && Buffer.isBuffer(value)) {
        return "buffer";
    }
    return typeof value;
}

// Traverse an object to get a value at a path
function get(root, path) {
    var target = root;
    for (var i = 0, l = path.length; i < l; i++) {
        target = target[path[i]];
    }
    return target;
}

// forEach that works on both arrays and objects
function forEach(value, callback, thisp) {
    if (typeof value.forEach === "function") {
        return value.forEach.call(value, callback, thisp);
    }
    var keys = Object.keys(value);
    for (var i = 0, l = keys.length; i < l; i++) {
        var key = keys[i];
        callback.call(thisp, value[key], key, value);
    }
}

// map that works on both arrays and objects
function map(value, callback, thisp, keyMap) {
    if (typeof value.map === "function") {
        return value.map.call(value, callback, thisp);
    }
    var obj = {};
    var keys = Object.keys(value);
    for (var i = 0, l = keys.length; i < l; i++) {
        var key = keys[i];
        obj[keyMap ? keyMap(key) : key] = callback.call(thisp, value[key], key, value);
    }
    return obj;
}
