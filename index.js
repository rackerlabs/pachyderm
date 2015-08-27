/**
   Output the contents of the directory tree into an npm-friendly `index.js`.
 */

var fs = require('fs');
var path = require('path');
var util = require('util');

var _ = require('lodash');
var walk = require('walkdir');

var indexTemplate = ['/**',
                     '%s',
                     ' */',
                     'module.exports = %s;'].join('\n');

/**
  In case there is a directory where there's already a leaf node (file), move the
  existing file to the "conflict" namespace (which is defined in `module.exports.appendToConflicts`).
  For instance,

  ├── overview
  │   ├── summary.js
  │   └── summary
  │       └── table.js
  └── overview.js

  `overview` cannot be both a .js file and a directory. This will move the .js file to
  a new key, which has 'Js' appended to it by default.
*/
var handleConflicts = function (treeObject, parentKey) {
    if (_.startsWith(treeObject[parentKey], 'require(')) {
        // move the .js file to the conflicted key, reset the directory to an empty object
        treeObject[parentKey + module.exports.appendToConflicts] = treeObject[parentKey];
        treeObject[parentKey] = {};
    }
};

/**
    Attach final k: v pair to associate an object-friendly name to a require statement
    since there are no more directories to traverse. For example:
    { searchPage: require('./search.page.js'); }

    This function accepts an optional `parentKey` argument. For deeper nodes in the directory
    hierarchy, the `parentKey` is the parent of the current node being manipulated. For nodes in the
    root of the directory hierarchy, there is no parent. For those, leave the `parentKey` argument undefined.
 */
var attachFilenameToLeafNode = function (treeObject, filenamePart, fullLocation, parentKey) {
    if (parentKey === undefined) {
        // we're in the root of the directory tree, so there is no `parentKey`
        treeObject[_.camelCase(filenamePart)] = 'require(\'./' + fullLocation + '\')';
    } else {
        handleConflicts(treeObject, parentKey);
        // we've traversed to the final child of the parent node `parentKey`. Now add the leaf.
        treeObject[parentKey][_.camelCase(filenamePart)] = 'require(\'./' + fullLocation + '\')';
    }
};

/**
   'search/results/keyword.table.js' becomes
   {
       search: {
           results: {
               keywordTable: require('./search/results/keyword.table.js')
           }
       }
   }
 */
var filenameToJson = function (jsonObject, filename) {
    var locationParts = filename.split(path.sep);

    var filenamePart = locationParts.pop().slice(0, -3); // remove '.js'
    var traversals = locationParts.length;

    // check if this file is in the root of the directory tree
    if (traversals === 0) {
        attachFilenameToLeafNode(jsonObject, filenamePart, filename);
    }

    // other nodes that are deeper in the tree will appear here
    _.reduce(locationParts, function (treeObject, locationPart) {
        if (treeObject[locationPart] === undefined) {
            treeObject[locationPart] = {};
        }

        traversals--;
        if (traversals === 0) {
            attachFilenameToLeafNode(treeObject, filenamePart, filename, locationPart);
        }

        // keep traversing vai `reduce`
        return treeObject[locationPart];
    }, jsonObject);
};

var sortJson = function (json) {
    if (!_.isObject(json)) {
        return json;
    }

    var sorted = {};
    _.forEach(_.keys(json).sort(), function (key) {
        sorted[key] = sortJson(json[key]);
    });

    return sorted;

};

/**
   `currentUsagePage = require('./currentUsage.page.js');`

   becomes

   `get currentUsagePage() { return require('./currentUsage.page.js'); }`

   Transform a line that requires a file right away to something that returns a getter that
   invokes a require function call on demand. This prevents module.exports from giving you back a giant object that
   requires everything in the package all at once.

   In summary, when you require an entire npm module like this, you shouldn't sit around waiting for 700ms or more
   while the *entire* catalog of the package's contents (and their dependencies) load for you. Instead, you only load the one
   file you're asking for, one at a time.

   If you're wondering why it's done this way, it's because adding keys to a javascript object can be stringified
   easily, but adding getters isn't supported by JSON.stringify. So this post-processing step avoids that issue.
 */
var convertToLazyRequireJson = function (jsonString) {
    return jsonString.replace(/(\w+): require\('\.\/([\w\.\/]+)'\)/g, 'get $1() { return require(\'./$2\'); }');
};

/**
   Will traverse a directory for files that pass `module.exports.shouldBeIndexed`, which is then processed
   into a javascript object that represents it's location in the file hierarchy. For example,

   $> tree test/pages
   ├── search
   │   ├── account.page.js
   │   ├── keyword.page.js
   │   └── results
   │       ├── account.table.js
   │       └── keyword.table.js
   ├── transactions.page.js
   └── util.js

   Would become

   module.exports = {
       search: {
            get accountPage() { return require('./search/account.page.js'); },
            get keywordPage() { return require('./search/keyword.page.js'); },
            results: {
                get accountTable() { return require('./search/results/account.table.js'); },
                get keywordTable() { return require('./search/results/keyword.table.js'); }
            }
        },
        get transactionsPage() { return require('./transactions.page.js'); },
        get util() { return require('./util.js'); }
   };
 */
var go = function (rules) {
    var json = {};

    // use the `rules` passed in by over-riding the global ones temporarily
    var oldRules = _.cloneDeep(module.exports);
    module.exports = _.defaults(rules, module.exports);
    var directory = path.resolve(module.exports.directory);
    var emitter = walk(directory);

    emitter.on('file', function (filename) {
        if (module.exports.shouldBeIndexed(filename)) {
            filename = filename.split(directory)[1];
            filename = _.startsWith(filename, '/') ? filename.slice(1) : filename;
            filenameToJson(json, filename, module.exports.appendToConflicts);
        }
    });

    emitter.on('end', function () {
        var greedyJson = JSON.stringify(sortJson(json), null, 4).replace(/"/g, '');
        var lazyJson = convertToLazyRequireJson(greedyJson);
        var toWrite = util.format(indexTemplate, module.exports.header, lazyJson);
        fs.writeFile(path.resolve(module.exports.output), toWrite, function (err) {
            if (!err) {
                console.log('Output file generated in', module.exports.output);
            }
        });
        // put the old global settings back
        module.exports = _.cloneDeep(oldRules);
    });

};

module.exports = {
    go: go,
    directory: path.resolve('.'),
    output: path.join(path.resolve('.'), 'index.js'),
    shouldBeIndexed: function (filename) {
        return _.all([
            filename.slice(-3) === '.js',
            filename.slice(-8) !== 'index.js',
            filename.match(/node_modules/) === null
        ]);
    },
    header: [
        ' This file is auto-generated by `pachyderm`.',
        ' https://www.npmjs.com/package/pachyderm'
    ].join('\n'),
    appendToConflicts: 'Js'
};
