var fs = require('fs'),
    path = require('path'),
    async = require('async'),
    _ = require('lodash'),
    di = require('./di'),
    vm = require('vm'),
    subRequire = require('./subRequire');

/**
 * The loader is used for dependency injection by the services container, and by the express/middleware service.
 *
 * services - services will be initialized in a well-defined order based on the dependency injection.
 *
 * consumers - like services except nothing will ever depend on a consumer.
 * It's therefore safe to load consumers in any order after services have been initialized.
 * Consumers are registered with a prefix in their name to avoid name collisions with services.
 * Since nothing has to reference a consumer by name, it doesn't matter what its name is.
 *
 * So at startup we do this
 * 1. Load all the service modules
 * 2. Load all the consumers (middleware, handlers)
 * 3. Initialize the services
 *
 * It's up to the services to init the consumers
 */
function createLoader() {

    var moduleMap = {}; //map id to module
    var dependencyMap = {}; //map id to list of dependencies
    var injectedMap = {}; //map id of objects that were manually injected
    var consumerMap = {}; //consumers will never be depended on by anything

    /**
     * Load a module with the given module name/id.
     * A normal require call is used under the covers, so it assume the module is available
     * somewhere in the node load path.
     *
     * In the cases that we're loading a service module that's a dependency of another external service module,
     * we have to do some magic with the require cache to properly load it.
     * @param id
     */
    function loadExternalModule(parentId, id) {
        var mod = subRequire(id, parentId);
        moduleMap[id] = mod;
        dependencyMap[id] = normalizeServiceNames(di.getParamNames(mod.init));
    }

    /**
     * Recursively find any unmet dependencies in the dependency tree.
     * Unmet dependencies are assumed to be third party modules, so it will
     * continue to load those modules until all dependencies have been met.
     */
    function fetchUnmetDependencies() {
        var runAgain = false;
        for (var id in dependencyMap) {
            var deps = dependencyMap[id];
            deps.forEach(function (depId) {
                if (!dependencyMap[depId] && !injectedMap[depId]) {
                    try {
                        loadExternalModule(id, depId);
                    } catch (err) {
                        throw new Error('Error loading dependency ' + depId + ' for ' + id + ': ' + err.message);
                    }

                    runAgain = true;
                }
            });
        }

        if (runAgain) { //continue until all we don't have any more unmet dependencies
            fetchUnmetDependencies();
        }
    }

    /**
     * Return a group of dependency load order, e.g.
     * [ ['a'], ['b', 'c'], ['d'] ].
     * If initList is specified, the dependencies will be grouped such that
     * they load in series.
     *
     * @param initList - an array of dependencies to force an order
     * @returns {*}
     */
    function calculateDependencyTree(initList) {
        if (initList) {
            var depGroups = [];
            initList.forEach(function(initList) {
                depGroups.push([initList]);
            });
            return depGroups;

        } else {

            var depCalc = require('./dependencyCalc');

            for (var id in dependencyMap) {
                var mod = moduleMap[id];
                 if (mod && mod.getDependencies) {

                     //dynamically look up deps with mod's getDependency function --used by express
                     var deps = normalizeServiceNames(mod.getDependencies.call(null, injectedMap['service-loader']));
                     deps = _.unique(deps.concat(dependencyMap[id]));
                     depCalc.addNode(id, deps);
                 } else {
                     depCalc.addNode(id, dependencyMap[id]);
                 }
            }

            //injected modules have no dependencies by default
            for (var id in injectedMap) {
                if (!dependencyMap[id]) { //when you do an inject, you can specify a dependency
                    depCalc.addNode(id, []);
                }
            }

            return depCalc.calcGroups(); //could throw an error
        }
    }

    return {
        /**
         * Register an object that wasn't loaded through the normal service/consumer mechanism.
         *
         * An optional dependency list can be specified.
         * @param id
         * @param obj
         * @param deps
         */
        inject: function (id, obj, deps) {
            var normId = normalizeServiceName(id);
            injectedMap[normId] = obj;

            if (deps) {
                dependencyMap[normId] = normalizeServiceNames(deps);
            }
        },

        /**
         * Load all the services in a given directory.
         *
         * The service is registered based on its filename, e.g. service.js is registered as service.
         * Dependencies are calculated based on the parameter names of the init method of the service.
         * @param dir
         */
        loadServices: function (dir) {
            var serviceList = [];
            if (fs.existsSync(dir)) {
                var files = fs.readdirSync(dir);
                files.forEach(function (file) {
                    if (path.extname(file) === '.js') {
                        var modPath = path.resolve(dir, file);
                        var mod = subRequire(modPath);
                        //subRequire inserts the _id field

                        var normId = normalizeServiceName(mod.__id);
                        moduleMap[normId] = mod;
                        dependencyMap[normId] = normalizeServiceNames(di.getParamNames(mod.init));
                    }
                });
            } else {
                //TODO: warn directory doesn't exist
            }
        },

        loadConsumers: function (dir, prefix) {
            var serviceList = [];
            if (fs.existsSync(dir)) {
                var files = fs.readdirSync(dir);
                files.forEach(function (file) {
                    if (path.extname(file) === '.js') {
                        var mod = require(path.resolve(dir, file));
                        var modId = normalizeServiceName(file.slice(0, -3));
                        consumerMap[prefix + '.' + modId] = mod;
                        dependencyMap[prefix + '.' + modId] = normalizeServiceNames(di.getParamNames(mod.init));
                    }
                });
            } else {
                //TODO: warn directory doesn't exist
            }
        },

        initConsumers: function(prefix, initList, callback) {
            if (typeof initList === 'function') {
                callback = initList;
                initList = null; //if not specified, init everything
            }

            var depList = [];
            if (initList) { //force init in the given order
                initList.forEach(function(item) {
                    depList.push(prefix + '.' + normalizeServiceName(item));
                });
            } else {
                //init all the services with the given prefix in the calculated order
                for (var key in consumerMap) {
                    if (key.indexOf(prefix + '.') === 0) {
                        depList.push(key);
                    }
                }
            }

            async.eachSeries(depList, function initConsumer(serviceId, initCallback) {
                var toLoad = consumerMap[serviceId];

                var isAsync = di.hasCallback(toLoad.init);

                var params = [];
                var deps = dependencyMap[serviceId];

                for (var i = 0; i < deps.length; i++) {
                    //will either come from module map or manual injection
                    var depMod = moduleMap[deps[i]] || injectedMap[deps[i]];
                    params.push(depMod);
                }
                if (isAsync) {
                    params.push(initCallback);
                    toLoad.init.apply(this, params);
                } else {
                    try {
                        toLoad.init.apply(this, params);
                        initCallback();
                    } catch (err) { //sync inits will have to throw errors to communicate problems
                        initCallback(err);
                    }
                }
            }, function initConsumerCallback(err) {
                callback(err);
            });

        },

        init: function (initList, callback) {
            if (typeof initList === 'function') {
                callback = initList;
                initList = null; //if not specified, init everything
            }

            try {
                fetchUnmetDependencies();
            } catch (err) {
                //can occur if an external dependency module isn't available
                return callback(err);
            }

            //calculate the dep tree and then init in order
            var depGroups = [];

            try {
                depGroups = calculateDependencyTree(initList);
            } catch (err) {
                //can fail for circular dependencies
                return callback(err);
            }

            async.eachSeries(depGroups, function (serviceIds, groupCallback) {

                async.each(serviceIds, function (serviceId, serviceCallback) {

                    //if this is a injected dependency or consumer, no need to init
                    if (injectedMap[serviceId] || consumerMap[serviceId]) {
                        return serviceCallback();
                    }

                    var toLoad = moduleMap[serviceId];

                    var isAsync = di.hasCallback(toLoad.init);

                    var params = [];
                    var deps = dependencyMap[serviceId];
                    for (var i = 0; i < deps.length; i++) {
                        //will either come from module map or manual injection
                        var depMod = moduleMap[deps[i]] || injectedMap[deps[i]];
                        params.push(depMod);
                    }

                    if (isAsync) {
                        params.push(serviceCallback);
                        toLoad.init.apply(this, params);

                    } else {
                        try {
                            toLoad.init.apply(this, params);
                            serviceCallback();
                        } catch (err) { //sync inits will have to throw errors to communicate problems
                            serviceCallback(err);
                        }
                    }
                }, function (err) {
                    groupCallback(err);
                });
            }, function (err) {
                callback(err);
            });
        },

        get: function (id) {
            return moduleMap[id];
        },

        unload: function(id) {
            subRequire.unload(id);
        },

        getConsumers: function(prefix) {
            var toReturn = [];
            for (var key in consumerMap) {
                if (key.indexOf(prefix + '.') === 0) {
                    toReturn.push(consumerMap[key]);
                }
            }
            return toReturn;
        }
    };
}


/*
 * Based off of https://github.com/epeli/underscore.string/blob/master/dasherize.js
 * Converts a camelCamel string into dash-case.
 */
function normalizeServiceName(str) {
    return str.replace(/([A-Z])/g, '-$1').replace(/[-_\s]+/g, '-').toLowerCase();
}

function normalizeServiceNames(names) {
    return _.map(names, function normalize(paramName) {
        return normalizeServiceName(paramName);
    });
}


exports = module.exports = createLoader;