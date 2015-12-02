"use strict";

/* Internal logic for tasks.
 *
 * A task has a name, a bunch of dependencies and a sequence of jobs.
 * This file here takes care of the internal logic of the tasks, while
 * the actual task definitions are contained in build.js and make use
 * of commands defined in commands.js.
 */

var Q = require("q");
var qfs = require("q-io/fs");
var path = require("path");
var fs = require("fs");

var commands = require("./commands");
var settings = require("./settings");
var BuildError = require("./BuildError");

var tasks = {};

var currentTask = null;

/* Define a new task. The definition is a function which describes the
 * task, without executing it yet. It should call the addJob method
 * and may also call input and output methods.
 */
exports.task = function(name, deps, definition) {
    if (["function", "undefined"].indexOf(typeof definition) === -1)
        throw Error("Invalid arguments for " + name);
    if (tasks.hasOwnProperty(name))
        throw Error("Dulicate name " + name);
    var res = currentTask = new Task(name, deps);
    if (definition)
        definition.call(res);
    tasks[name] = res;
    currentTask = null;
    return res;
};

/* Retrieve a task by name. Thows an error if no match is found.
 */
exports.get = function(name) {
    if(tasks.hasOwnProperty(name))
        return tasks[name];
    throw new BuildError("No task named " + name);
};

/* Identify the task currently being defined.
 */
exports.current = function() {
    return currentTask;
};

/* Execute the named tasks sequentially or in parallel
 * depending on the “parallel” setting.
 * Returns an array of booleans indicating which tasks got run.
 */
exports.schedule = function(taskNames) {
    if (settings.get("parallel") === "true") {
        return Q.all(taskNames.map(function(name){
            return exports.get(name).promise();
        }));
    }
    else {
        var results = [];
        var promise = Q();
        taskNames.forEach(function(name) {
            var task = exports.get(name);
            promise = promise
                .then(task.promise.bind(task))
                .then(function(result) {
                    results.push(result);
                    return results;
                });
        });
        return promise;
    }
};

/* Constructor for task objects.
 */
function Task(name, deps) {
    this.name = name;
    this.deps = deps;
    this.outputs = [];
    this.inputs = [];
    this.settings = {};
    this.jobs = [];
}

/* Adopt all commands as methods.
 */
for (var cmd in commands) {
    Task.prototype[cmd] = commands[cmd];
}

Task.prototype.log = function() {
    if (settings.get("verbose") !== "")
        console.log.apply(console, arguments);
};

/* Add a new job. The provided function will be called when the task
 * is run, and should return a promise. By default jobs are executed
 * sequentially.
 */
Task.prototype.addJob = function(job) {
    this.jobs.push(job);
};

/* Run a bunch of jobs in parallel. This collects all job definitions
 * which occur from within the callback and executes those jobs in
 * parallel.
 */
Task.prototype.parallel = function(callback) {
    if (settings.get("parallel") === "false") {
        callback.call(this);
        return;
    }
    var backup = this.jobs;
    var lst = this.jobs = [];
    callback.call(this);
    this.jobs = backup;
    this.addJob(function() {
        return Q.all(lst.map(function(job) { return job(); }));
    });
};

/* Register one or more input files. These will be compared against
 * the outputs to see whether the targets are up to date.
 */
Task.prototype.input = function(file) {
    if (Array.isArray(file)) {
        file.forEach(this.input.bind(this));
    } else if (this.outputs.indexOf(file) === -1) {
        this.inputs.push(file);
    }
    return file;
};

/* Register one or more output files.These will be compared against
 * the inputs to see whether the targets are up to date.
 */
Task.prototype.output = function(file) {
    if (Array.isArray(file)) {
        file.forEach(this.output.bind(this));
    } else {
        this.outputs.push(file);
    }
    return file;
};

Task.prototype.forceRun = function(message) {
    this.runForced = message || "it was requested";
};


Task.prototype.allDeps = function(f) {
    return Q.all(this.deps.map(function(name) {
        return f(exports.get(name));
    }));
};

function times(files) {
    return Q.all(files.map(function(path) {
        return qfs.stat(path)
            .then(function(stat) {
                return stat.lastModified().getTime();
            }, function(err) {
                if (err.code === "ENOENT")
                    return null;
                throw err;
            });
    }));
}

/* Returns a promise indicating whether this task should be run or
 * skipped.
 */
Task.prototype.mustRun = function() {
    if (this.mustRunCache)
        return this.mustRunCache;
    var task = this;
    var log = function(){};
    if (settings.get("debug"))
        log = function(msg) { console.log(task.name + " " + msg); };
    if (this.outputs.length === 0 && this.jobs.length !== 0) {
        // There are no outputs, so this task runs for its side effects.
        // This avoids having to declare all such tasks as PHONY.
        log("has no outputs; run it");
        return this.mustRunCache = Q(true);
    }
    if (this.runForced) {
        this.log("Forcing run of " + this.name + " since " + this.runForced);
        return this.mustRunCache = Q(true);
    }
    return this.mustRunCache = this
        .allDeps(function(dep) { return dep.mustRun(); })
        .then(function(depsMustRun) {
            if (depsMustRun.indexOf(true) !== -1) {
                // There is one dependency which will be run,
                // so we need to run ourselves
                log("has a running dependency; run it");
                return true;
            }
            return Q.all([times(task.inputs), times(task.outputs)])
                .spread(function(inTimes, outTimes) {
                    if (outTimes.indexOf(null) !== -1) {
                        // At least one output file missing, so run
                        log("has missing output; run it");
                        return true;
                    }
                    var inTime = Math.max.apply(null, inTimes);
                    var outTime = Math.min.apply(null, outTimes);
                    if (inTime <= outTime) {
                        // All outputs are up to date, don't run
                        log("is up to date; skip it");
                        return false;
                    }
                    log("is outdated; run it");
                    return true;
                });
        });
};

/* Returns a promise representing the complete execution of this task.
 * This means running all dependencies, checking whether targets are
 * up to date, if not running the jobs. The result is a promise which
 * resolves to true if the task actually ran, or to false otherwise.
 */
Task.prototype.promise = function() {
    if (this.promiseCache)
        return this.promiseCache;
    var task = this;
    return this.promiseCache =
        this.mustRun()
        .then(function(doRun) {
            if (!doRun) return false;
            return exports.schedule(task.deps)
                .then(task.mkdirs.bind(task))
                .then(task.run.bind(task))
                .then(function() {
                    // successful run: remember the settings in use
                    settings.remember(task.name, task.settings);
                    return true;
                }, function(err) {
                    // failed run: forget all settings just to be safe
                    settings.forget(task.name);
                    // try to delete all outputs, but ignore any errors
                    function rethrow() { throw err; }
                    return Q.allSettled(task.outputs.forEach(function(name) {
                        return Q.nfcall(fs.unlink, name);
                    })).then(rethrow, rethrow);
                });
        });
};

Task.prototype.mkdirs = function() {
    var dirs = {};
    this.outputs.forEach(function(name) {
        dirs[path.dirname(name)] = true;
    });
    dirs = Object.keys(dirs);
    dirs.sort(function(a, b) {
        return a.length - b.length;
    });
    return Q.all(dirs.map(function(name) {
        return qfs.makeTree(name, 7*8*8 + 7*8 + 7);
    }));
};

Task.prototype.run = function() {
    return this.jobs.reduce(Q.when, Q());
};
