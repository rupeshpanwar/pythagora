const path = require("path");
const {PYTHAGORA_UNIT_DIR} = require("../const/common");
const fs = require("fs").promises;
const fsSync = require("fs");


async function checkPathType(path) {
    let stats = await fs.stat(path);
    return stats.isFile() ? 'file' : 'directory';
}

function getRelativePath(filePath, referenceFolderPath) {
    let relativePath = path.relative(path.resolve(referenceFolderPath), filePath);
    if (!relativePath.startsWith('../') && !relativePath.startsWith('./')) {
        relativePath = './' + relativePath;
    }
    return relativePath;
}


function getFolderTreeItem(prefix, isLast, name, absolutePath) {
    const stat = fsSync.statSync(absolutePath);
    return {
        line: `${prefix}${isLast ? '└───' : '├───'}${name}`,
        absolutePath,
        isDirectory: stat.isDirectory()
    };
}

function isPathInside(basePath, targetPath) {
    const relativePath = path.relative(basePath, targetPath);
    return !relativePath.startsWith('..') && !path.isAbsolute(relativePath);
}

function getTestFolderPath(filePath, rootPath) {
    return path.join(
        path.resolve(PYTHAGORA_UNIT_DIR),
        path.dirname(filePath).replace(rootPath, ''),
        path.basename(filePath, path.extname(filePath))
    );
}

module.exports = {
    checkPathType,
    getRelativePath,
    getFolderTreeItem,
    isPathInside,
    getTestFolderPath
}
