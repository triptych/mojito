/*
 * Copyright (c) 2011-2013, Yahoo! Inc.  All rights reserved.
 * Copyrights licensed under the New BSD License.
 * See the accompanying LICENSE file for terms.
 */


/*jslint anon:true, sloppy:true, nomen:true, node: true*/
/*global YUI*/


/**
 * @module ActionContextAddon
 */
YUI.add('mojito-deploy-addon', function(Y, NAME) {

    'use strict';

    var liburl  = require('url');

    /**
     * <strong>Access point:</strong> <em>ac.deploy.*</em>
     * Provides ability to create client runtime deployment HTML
     * @class Deploy.server
     */
    function Addon(command, adapter, ac) {
        this.instance = command.instance;
        this.scripts = {};
        this.ac = ac;
        this.rs = null;
    }


    Addon.prototype = {

        namespace: 'deploy',

        /**
         * Declaration of store requirement.
         * @method setStore
         * @private
         * @param {ResourceStore} rs The resource store instance.
         */
        setStore: function(rs) {
            this.rs = rs;
        },

        /**
         * Builds up the browser Mojito runtime.
         * @method constructMojitoClientRuntime
         * @param {AssetHandler} assetHandler asset handler used to add scripts
         *     to the DOM under construction.
         * @param {object} binderMap information about the binders that will be
         *     deployed to the client.
         */
        constructMojitoClientRuntime: function(assetHandler, binderMap) {

            //Y.log('Constructing Mojito client runtime', 'debug', NAME);

            var store = this.rs,
                contextServer = this.ac.context,

                appConfigServer = store.getAppConfig(contextServer),
                appGroupConfig,
                seedFiles,

                contextClient,
                appConfigClient,
                yuiConfig = {},
                yuiConfigEscaped,
                yuiConfigStr,
                viewId,
                i,
                clientConfig = {},
                clientConfigEscaped,
                clientConfigStr,
                initialModuleList = {},
                initializer, // script for YUI initialization
                pathToRoot;

            contextClient = Y.mojito.util.copy(contextServer);
            contextClient.runtime = 'client';
            appConfigClient = store.getAppConfig(contextClient);
            appGroupConfig  = store.yui.getAppGroupConfig(contextClient);
            seedFiles       = store.yui.getAppSeedFiles(contextClient);
            clientConfig.context = contextClient;

            yuiConfig = Y.merge({

                fetchCSS: true,
                combine: true,
                // the base path for non-combo paths
                base: 'http://yui.yahooapis.com/' + Y.version + '/build/',
                // the path to the combo service
                comboBase: 'http://yui.yahooapis.com/combo?',
                // a fragment to prepend to the path attribute when
                // when building combo urls
                root: Y.version + '/build/',
                groups: {
                    app: appGroupConfig
                }

            }, ((appConfigClient.yui && appConfigClient.yui.config) || {}), {
                lang: contextServer.lang // same as contextClient.lang
            });
            // yui.config goes through a different channel (yuiConfig),
            // so we should remove it from the appConfigClient.
            if (appConfigClient.yui.config) {
                appConfigClient.yui.config = undefined;
            }

            // adjusting seed files and modules
            seedFiles = this._getSeedAssets(seedFiles, appGroupConfig);
            // attaching seed files
            for (i = 0; i < seedFiles.length; i += 1) {
                assetHandler.addAsset('js', 'top', seedFiles[i]);
            }

            // adding the default module for the Y.use statement in the client
            initialModuleList['mojito-client'] = true;

            // add binders' dependencies
            for (viewId in binderMap) {
                if (binderMap.hasOwnProperty(viewId)) {
                    if (binderMap[viewId].name) {
                        initialModuleList[binderMap[viewId].name] = true;
                    }
                }
            }

            clientConfig.binderMap = binderMap;

            // we need the app config on the client for log levels (at least)
            clientConfig.appConfig = appConfigClient;

            // this is mainly used by html5app
            pathToRoot = this.ac.http.getHeader('x-mojito-build-path-to-root');
            if (pathToRoot) {
                clientConfig.pathToRoot = pathToRoot;
            }

            clientConfig.routes = this.ac.url.getRouteMaker().getComputedRoutes();

            // Unicode escape the various strings in the config data to help
            // fight against possible script injection attacks.
            // @caridy: this sounds like a big hack :)
            yuiConfigEscaped = Y.mojito.util.cleanse(yuiConfig);
            if (yuiConfig.comboSep) {
                yuiConfigEscaped.comboSep = yuiConfig.comboSep;
            }
            if (yuiConfig.groups && yuiConfig.groups.app &&
                    yuiConfig.groups.app.comboSep) {
                yuiConfigEscaped.groups.app.comboSep = yuiConfig.groups.app.comboSep;
            }

            yuiConfigStr = JSON.stringify(yuiConfigEscaped);
            clientConfigEscaped = Y.mojito.util.cleanse(clientConfig);
            clientConfigStr = JSON.stringify(clientConfigEscaped);

            initialModuleList = "'" + Y.Object.keys(initialModuleList).join("','") + "'";

            initializer = '<script type="text/javascript">\n' +
                '    YUI.applyConfig(' + yuiConfigStr + ');\n' +
                '    YUI().use(' + initialModuleList + ', function(Y) {\n' +
                '    window.YMojito = { client: new Y.mojito.Client(' +
                clientConfigStr + ') };\n' +
                '        });\n' +
                '</script>\n';

            // Add the boot script
            assetHandler.addAsset('blob', 'bottom', initializer);
        },

        /**
         * Generate the YUI seed file to use on the client.
         * This has to be done before any other scripts are
         * added.
         * @method _getSeedAssets
         * @protected
         * @param {Array} seedFiles List of module names or urls
         * that conform the application seed, this is usually coming from
         * application.json->yui->config->seed=[].
         * @param {Object} appGroupConfig The configuration for the loader for
         * app specific modules, this is usually coming from:
         * application.json->yui->config->groups->app->{}.
         * @return {Array} list of assets that represents the app seed.
         */
        _getSeedAssets: function (seedFiles, appGroupConfig) {
            var i,
                assets = [],
                modules = [],
                protocol,
                flushModulesQueue = function () {
                    // using combo for the seed modules
                    if (modules.length > 0) {
                        assets.push(appGroupConfig.comboBase +
                                appGroupConfig.root + modules.join(appGroupConfig.comboSep +
                                appGroupConfig.root));
                        modules = [];
                    }
                };

            for (i = 0; i < seedFiles.length; i += 1) {
                protocol = liburl.parse(seedFiles[i]).protocol;
                if (protocol) {
                    // flushing queue to preserve the order
                    flushModulesQueue();
                    // the item is a fullpath url
                    assets.push(seedFiles[i]);
                } else if (appGroupConfig.combine === false) {
                    // flushing queue to preserve the order
                    flushModulesQueue();
                    // if the combo is disabled, then we need to insert one by one
                    // this is useful for offline and hybrid apps where the combo
                    // does not work.
                    assets.push(appGroupConfig.base +
                            appGroupConfig.root + seedFiles[i]);
                } else {
                    // the item is a module and should be combined
                    modules.push(seedFiles[i]);
                }
            }

            flushModulesQueue();

            return assets;
        }

    };

    Y.namespace('mojito.addons.ac').deploy = Addon;

}, '0.1.0', {requires: [
    'mojito-util',
    'mojito-http-addon',
    'mojito-url-addon'
]});
