"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const child_process_1 = require("child_process");
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const wait = () => new Promise(resolve => {
    setTimeout(resolve, 100);
});
exports.start = function ({ port, service, modules, replica, verbose = false }) {
    return __awaiter(this, void 0, void 0, function* () {
        if (verbose)
            console.info('Start db 🌈');
        if (service instanceof Promise) {
            if (verbose) {
                console.info('awaiting service');
            }
            service = yield service;
            if (verbose) {
                console.info('service', service);
            }
        }
        if (port instanceof Promise) {
            if (verbose) {
                console.info('awaiting port');
            }
            port = yield port;
        }
        if (replica instanceof Promise) {
            if (verbose) {
                console.info('awaiting db to replicate');
            }
            replica = yield replica;
            if (verbose) {
                console.info('replica', replica);
            }
        }
        if (!port && service) {
            port = service.port;
            if (verbose) {
                console.info('listen on port', port);
            }
        }
        const args = ['--port', String(port), '--protected-mode', 'no'];
        if (modules) {
            modules.forEach(m => {
                const platform = process.platform + '_' + process.arch;
                const p = path_1.default.join(__dirname, '../', 'modules', platform, m + '.so');
                if (fs_1.default.existsSync(p)) {
                    if (verbose) {
                        console.info(`  Load redis module "${m}"`);
                    }
                    args.push('--loadmodule', p);
                }
                else {
                    console.warn(`${m} module does not exists for "${platform}"`);
                }
            });
        }
        if (replica) {
            args.push('--replicaof', replica.host, String(replica.port));
        }
        const tmpPath = path_1.default.join(process.cwd(), './tmp');
        if (!fs_1.default.existsSync(tmpPath)) {
            fs_1.default.mkdirSync(tmpPath);
        }
        try {
            const dir = args[args.indexOf('--dir') + 1];
            child_process_1.execSync(`redis-cli -p ${port} config set dir ${dir}`);
            child_process_1.execSync(`redis-cli -p ${port} shutdown`);
        }
        catch (e) { }
        const redisDb = child_process_1.spawn('redis-server', args);
        const redisServer = {
            on: (type, cb) => {
                if (type === 'error') {
                    redisDb.stderr.on('data', cb);
                }
                else if (type === 'data') {
                    redisDb.stdout.on('data', cb);
                }
                else {
                    redisDb.on('close', cb);
                }
            },
            destroy: () => __awaiter(this, void 0, void 0, function* () {
                child_process_1.execSync(`redis-cli -p ${port} shutdown`);
                redisDb.kill();
                yield wait();
            })
        };
        // cleanExit(port)
        return redisServer;
    });
};
//# sourceMappingURL=index.js.map