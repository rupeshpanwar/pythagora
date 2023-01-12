// import {v4} from 'uuid';
// import { createHook, triggerAsyncId, executionAsyncId } from 'async_hooks';
// import { BatchInterceptor } from '@mswjs/interceptors';
// import nodeInterceptors from '@mswjs/interceptors/lib/presets/node.js';
// import mongoose from "mongoose";
// import FS from "fs";
// import _ from "lodash";
// import { AsyncLocalStorage, AsyncResource } from 'node:async_hooks';
// import RedisInterceptor from './RedisInterceptor.js';

let  mongoose = require("mongoose");
let  {v4} = require('uuid');
let  { createHook, triggerAsyncId, executionAsyncId } = require('async_hooks');
let  { BatchInterceptor } = require('@mswjs/interceptors');
let  nodeInterceptors = require('@mswjs/interceptors/lib/presets/node.js');
let  FS = require("fs");
let  _ = require("lodash");
let  { AsyncLocalStorage, AsyncResource } = require('node:async_hooks');
const RedisInterceptor = require("./RedisInterceptor.js");

const asyncLocalStorage = new AsyncLocalStorage();

function logWithStoreId(msg) {
    const id = asyncLocalStorage.getStore();
    console.log(`${id !== undefined ? id : '-'}:`, msg);
}

let idSeq = 0;
let loggingEnabled;
let requests = {};
let testingRequests = {};
let methods = ['find', 'insert', 'update', 'delete', 'deleteOne', 'insertOne', 'updateOne', 'updateMany', 'deleteMany', 'replaceOne', 'replaceOne', 'remove', 'findOneAndUpdate', 'findOneAndReplace', 'findOneAndRemove', 'findOneAndDelete', 'findByIdAndUpdate', 'findByIdAndRemove', 'findByIdAndDelete', 'exists', 'estimatedDocumentCount', 'distinct', 'translateAliases', '$where', 'watch', 'validate', 'startSession', 'diffIndexes', 'syncIndexes', 'populate', 'listIndexes', 'insertMany', 'hydrate', 'findOne', 'findById', 'ensureIndexes', 'createIndexes', 'createCollection', 'create', 'countDocuments', 'count', 'bulkWrite', 'aggregate'];
let app;
let MODES = {
    'capture': 'capture',
    'test': 'test'
};

class Pytagora {

    constructor(mode) {
        if (!MODES[mode]) throw new Error('Invalid mode');
        else this.mode = mode;
        loggingEnabled = mode === 'capture';

        if (!FS.existsSync('./pytagora_data/')) FS.mkdirSync('./pytagora_data/');

        this.configureMongoosePlugin();

        this.setUpHttpInterceptor();
    }

    setApp(newApp) {
        app = newApp;
        this.setUpExpressMiddleware(app);
    }

    getApp() {
        return app;
    }

    setUpHttpInterceptor() {
        const interceptor = new BatchInterceptor({
            name: 'my-interceptor',
            interceptors: nodeInterceptors.default,
        });

        interceptor.apply();

        interceptor.on('request', (req, reqId) => this.httpRequestInterceptor(req, reqId, this));
        interceptor.on('response', (res, req) => this.httpResponseInterceptor(res, req, this));
    }

    httpRequestInterceptor(request, requestId, pytagora) {
        if (pytagora.mode === MODES.test) {
            let mockResponse = pytagora.getHttpMockResponse(request);
            if (!mockResponse) return console.error('No mock response found for request!');

            request.respondWith(
                new Response(
                    JSON.stringify(mockResponse.responseData),
                    {
                        status: mockResponse.response.status,
                        statusText: mockResponse.response.statusText,
                        // TODO headers: mockResponse.response.headers
                    }
                )
            )
        }
    }

    async httpResponseInterceptor(response, request, pytagora) {
        if (pytagora.mode !== MODES.capture) return;
        async function readStream(reader) {
            let result;
            let values = [];
            while (!result || !result.done) {
                result = await reader.read();
                values.push(result.value);
            }

            let finalResult = values.join('').toString('utf8');
            try { finalResult = JSON.parse(finalResult); } catch (e) {}
            return finalResult;
        }

        let reader = response.body.getReader();
        let responseBody = await readStream(reader);
        if (!requests[Pytagora.getRequestKeyByAsyncStore()]) return console.error('No TRACE found for response!');
        requests[Pytagora.getRequestKeyByAsyncStore()].intermediateData.push({
            type: 'outgoing_request',
            url: request.url,
            method: request.method,
            responseData: responseBody,
            response: {
                status: response.status,
                statusText: response.statusText,
                // TODO headers: response.headers
            }
        });
    }

    // TODO track request order and make sure the correct ones get chosen
    getHttpMockResponse(request) {
        return testingRequests[asyncLocalStorage.getStore()].intermediateData.find(intData => {
            // TODO add more checks (body, query, params)
            return intData.type === 'outgoing_request' &&
                intData.url === request.url &&
                intData.method === request.method;
        });
    }

    setUpExpressMiddleware(app) {
        app.use(async (req, res, next) => {
            this.RedisInterceptor.setMode(this.mode);
            if (this.mode === MODES.capture) await this.apiCaptureInterceptor(req, res, next, this);
            else if (this.mode === MODES.test) await this.apiTestInterceptor(req, res, next, this);
        });
    }

    static getRequestKeyByAsyncStore() {
        return Object.keys(requests).find(key => {
            return requests[key].asyncStore === asyncLocalStorage.getStore();
        });
    }

    updateTrace(asyncId, triggerAsyncId) {
        for (let i = 0; i < Object.keys(requests).length; i++) {
            if (requests[Object.keys(requests)[i]].trace.includes(triggerAsyncId)) {
                requests[Object.keys(requests)[i]].trace.push(asyncId);
                break;
            }
        }
    }

    configureMongoosePlugin() {
        let self = this;
        mongoose.plugin((schema) => {
            schema.pre(methods, function() {
                if (asyncLocalStorage.getStore() === undefined) return;
                logWithStoreId('mongo pre');
                this.asyncStore = asyncLocalStorage.getStore();
                this.mongoReqId = v4();
                try {
                    let request = requests[Pytagora.getRequestKeyByAsyncStore()];
                    if (request) request.intermediateData.push({
                        type: 'mongo',
                        req: _.pick(this, ['op', 'options', '_conditions', '_fields', '_update', '_path', '_distinct', '_doc']),
                        mongoReqId: this.mongoReqId
                    });
                } catch (e) {
                    console.log(_.pick(this, ['op', '_conditions', '_doc']), e);
                }
            });

            schema.post(methods, function(...args) {
                let doc = args[0];
                let next = args[1];
                if (this.asyncStore === undefined) return;
                try {
                    asyncLocalStorage.enterWith(this.asyncStore);
                    logWithStoreId('mongo post');
                    if (self.mode === MODES.test) {
                        let request = testingRequests[this.asyncStore];
                        doc = request.intermediateData.find(d => d.type === 'mongo');
                        if (doc) doc = doc.res;
                    } else {
                        let request = requests[Pytagora.getRequestKeyByAsyncStore()] || testingRequests[this.asyncStore];
                        if (request) request.intermediateData.forEach((intData, i) => {
                            if (intData.mongoReqId === this.mongoReqId) {
                                request.intermediateData[i].res = doc;
                            }
                        });
                        if (!request || !request.intermediateData.find(intData => intData.mongoReqId === this.mongoReqId)) {
                            console.log('---');
                        }
                    }
                } catch (e) {
                    console.log(e);
                }
                if (next) next();
            });
        });
    }

    async apiCaptureInterceptor(req, res, next) {

        let eid = executionAsyncId();
        // createHook({ init() {} }).enable();
        req.id = v4();
        requests[req.id] = {
            id: req.id,
            endpoint: req.path,
            url: 'http://' + req.headers.host + req.url,
            body: req.body,
            method: req.method,
            headers: req.headers,
            responseData: null,
            traceId: eid,
            trace: [eid],
            intermediateData: [],
            query: req.query,
            params: req.params,
            asyncStore: idSeq
        };

        //todo check what else needs to be added eg. res.json, res.end, res.write,...
        const _send = res.send;
        const _redirect = res.redirect;

        res.send = function(body) {
            logWithStoreId('send');
            // TODO save response data
            requests[req.id].responseData = body;
            requests[req.id].traceLegacy = requests[req.id].trace;
            requests[req.id].trace = [];
            if (loggingEnabled) Pytagora.saveCaptureToFile(requests[req.id]);
            _send.call(this, body);
        };

        res.redirect = function(redirectUrl) {
            logWithStoreId('redirect');
            requests[req.id].responseData = {
                'type': 'redirect',
                'url': redirectUrl
            };
            if (loggingEnabled) Pytagora.saveCaptureToFile(requests[req.id]);
            _redirect.call(this, redirectUrl);
        };


        asyncLocalStorage.run(idSeq++, () => {
            logWithStoreId('start');
            next();
        });
    }

    static saveCaptureToFile(reqData) {
        let endpointFileName = `./pytagora_data/${reqData.endpoint.replace(/\//g, '|')}.json`;
        if (!FS.existsSync(endpointFileName)) FS.writeFileSync(endpointFileName, JSON.stringify([reqData]));
        else {
            let fileContent = JSON.parse(FS.readFileSync(endpointFileName));
            let identicalRequestIndex = fileContent.findIndex(req => {
                return _.isEqual(req.body, reqData.body) &&
                    req.method === reqData.method &&
                    _.isEqual(req.query, reqData.query) &&
                    _.isEqual(req.params, reqData.params);
            });

            if (identicalRequestIndex === -1) {
                FS.writeFileSync(endpointFileName, JSON.stringify(fileContent.concat([reqData])));
            } else {
                fileContent[identicalRequestIndex] = reqData;
                FS.writeFileSync(endpointFileName, JSON.stringify(fileContent));
            }
        }
    }

    async apiTestInterceptor(req, res, next) {
        let path = `./pytagora_data/${req.path.replace(/\//g, '|')}.json`;
        if (!FS.existsSync(path)) return next();
        let capturedRequests = JSON.parse(await FS.promises.readFile(path, 'utf8'));
        let request = this.getRequestMockData(capturedRequests, req.path, req.method, req.body, req.query, req.params);
        if (!request) return console.error('No request found for', req.path, req.method, req.body, req.query, req.params);
        this.RedisInterceptor.setIntermediateData(request.intermediateData);
        let reqId = idSeq++;
        testingRequests[reqId] = request;

        // const self = this;
        //todo check what else needs to be added eg. res.json, res.end, res.write,...
        const _send = res.send;
        const _redirect = res.redirect;

        res.send = function(body) {
            logWithStoreId('testing send');
            // if (!request || !self.compareResponse(request.responseData, body)) console.error('BEEP BEEP! Wrong response in test');
            _send.call(this, body);
        };

        res.redirect = function(url) {
            logWithStoreId('testing redirect');
            // if (!request ||
            //     !self.compareResponse(request.responseData, {
            //         type: 'redirect',
            //         url
            //     })) console.error('BEEP BEEP! Wrong response in test');
            _redirect.call(this, url);
        };

        asyncLocalStorage.run(reqId, () => {
            logWithStoreId('Starting testing...');
            next();
        });
    }

    compareResponse(a, b) {
        return typeof a !== typeof b ? false :
            typeof a === 'string' && a.toLowerCase().includes('<!doctype html>') && b.toLowerCase().includes('<!doctype html>') ? true : //todo make appropriate check
                typeof a === 'object' ? this.compareJson(a,b) : a === b;
    }

    compareJson(a, b) {
        let aProps = Object.getOwnPropertyNames(a);
        let bProps = Object.getOwnPropertyNames(b);
        if (aProps.length !== bProps.length) {
            return false;
        }
        for (let i = 0; i < aProps.length; i++) {
            let propName = aProps[i];
            if (a[propName] !== b[propName]) {
                if (typeof a[propName] === 'object') {
                    if (!this.compareJson(a[propName], b[propName]))
                        return false;
                } else
                    return false;
            }
        }
        return true;
    }

    getRequestMockData(capturedRequests, endpoint, method, body, query, params) {
        return capturedRequests.find(request => {
            return request.endpoint === endpoint &&
                request.method === method &&
                _.isEqual(request.body, body) &&
                _.isEqual(request.query, query) &&
                _.isEqual(request.params, params);
        });
    }

    async runRedisInterceptor(intermediateData) {
        this.RedisInterceptor = new RedisInterceptor(
            this,
            16379,
            6379,
            intermediateData
        );

        await this.RedisInterceptor.init();

    }

    saveRedisData(request, response) {
        _.keys(requests).forEach(k => requests[k].intermediateData.push({
            type: 'redis',
            request, response
        }));
    }

}

// export default Pytagora;

module.exports = Pytagora;
