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
Object.defineProperty(exports, "__esModule", { value: true });
const s3api_1 = require("./s3api");
function cleanUpOldBackups(s3, bucketName, retentionInDays) {
    return __awaiter(this, void 0, void 0, function* () {
        const objects = yield s3.listObjects(bucketName);
        const oldBackups = objects.filter(object => {
            const validSince = new Date(Date.now() - 1000 * 60 * 60 * 12 * retentionInDays);
            return object.LastModified < validSince;
        });
        yield Promise.all(oldBackups.map(object => {
            return s3.deleteObject(bucketName, object.Key);
        }));
    });
}
function mkBackupFn(opts) {
    return __awaiter(this, void 0, void 0, function* () {
        const { endpoint, backupRetentionInDays, bucketName, config } = opts;
        const s3 = s3api_1.createApi(config, endpoint);
        yield s3.ensureBucket(bucketName, 'private');
        return (rdbFilePath) => __awaiter(this, void 0, void 0, function* () {
            const dstFilepath = new Date().toISOString();
            console.log(`storing file from ${rdbFilePath} to ${dstFilepath}`);
            yield s3.storeFile(bucketName, dstFilepath, rdbFilePath);
            // await cleanUpOldBackups(s3, bucketName, backupRetentionInDays)
        });
    });
}
exports.default = mkBackupFn;
//# sourceMappingURL=index.js.map