var fs = require('fs');
var nodePath = require('path');

const args = parseArgs(process.argv.slice(2))
var pathToLess = args['-styles']
var pathToJSON = args['-json']
var pathToResultCSS = args['-css']
var pathToResultVars = args['-vars']
var pluginNamesSrc = args['-plugins']
var pluginNames = pluginNamesSrc != undefined ? pluginNamesSrc.split(',') : undefined
var lessPath = ''
var lessVars = {}
var sketchRules = []
var parseOptions = null
var _lookups = {}

/////////////////////////////////////////////
console.log("Started")

// INIT DATA
if (!initPaths()) process.exit(0)

// LOAD LESS
var strSrcLess = loadLessFromFiles(pathToLess)
if (null == strSrcLess) process.exit(-1)

// SAVE TOKENS AS COMMENTS IN LESS
var strLess = injectTokensIntoLess(strSrcLess)

// RENDER LESS TO JSON
transformLESStoJSON(strLess)

// RENDER CUSTOM LESS TO RAW CSS
if (undefined != pathToResultCSS)
    transformCustomLESStoCSS(pathToLess, pathToResultCSS)

////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
function parseArgs(args) {
    let list = []
    args.forEach(function (arg) {
        const v = arg.split("=")
        if (0 == v.length) return
        list[v[0]] = v[1]
    })
    return list
}

function initPaths() {
    if (undefined == pathToLess) {
        console.log("nsconvert_less.js -styles=<PATH_TO_LESS_FILE> -json=<PATH_TO_JSON_FILE> -css=<pathToResultCSS> -vars=<pathToResultVars> -plugins=[plugin1,plugin2]")
        return false
    }

    // REMOVE OLD RESULTS
    if (pathToJSON && fs.existsSync(pathToJSON)) {
        fs.unlinkSync(pathToJSON)
    }

    // CHANGE CURRENT PATH TO LESS FOLDER TO ENABLE IMPORTS
    lessPath = nodePath.dirname(pathToLess)
    process.chdir(lessPath)

    return true
}

function injectTokensIntoLess(srcData) {
    var lessLines = srcData.split("\n")
    var newData = ""

    lessLines.forEach(function (line) {

        // drop comment lines
        line = line.trim()
        if (line.startsWith("//")) return

        var found = line.match(/@{1}([\w-]*)\w{0,};/)
        if (null != found && found.length >= 1) {
            var token = found[1]
            var commentPos = line.indexOf("//")
            if (commentPos > 0) {
                line = line.substring(0, commentPos)
            }
            line += " //!" + token + "!"
        }
        newData += line + "\n"
    })

    return newData
}

function loadLessFromFiles(fileName1, fileName2) {
    console.log("Read LESS: running...")

    var data = ''
    const data1 = fs.readFileSync(fileName1, 'utf8');
    if (null == data1) {
        console.log("Can't open file by path:" + fileName1)
        return null
    }
    data = data + data1;
    if (fileName2 != undefined) {
        data = data + "\n" + fs.readFileSync(fileName2, 'utf8');
    }

    return data
}

function transformLESStoJSON(data) {

    var passToNodeModules = _getPathToNodeModules()
    var less = require(passToNodeModules + "/less")

    var pluginModules = []
    if (undefined != pluginNames) {
        pluginNames.forEach(function (pluginName) {
            const pluginModule = require(passToNodeModules + "/" + pluginName);
            pluginModules.push(pluginModule)
        })
    }

    var options1 = {
        async: false,
        fileAsync: false,
        plugins: pluginModules,
    }

    process.on('unhandledRejection', error => {
        // Will print "unhandledRejection err is not defined"
        console.log('Failed to parse LESS with error message:', error.message);
        process.exit(-1)
    });


    try {
        less.parse(data, options1, function (err, root, imports, options) {
            parseOptions = options
            //console.log(options.pluginManagermixin)
            if (undefined != err) console.log(err)

            var evalEnv = new less.contexts.Eval(options);
            var evaldRoot = root.eval(evalEnv);
            var ruleset = evaldRoot.rules;

            ruleset.forEach(function (rule) {
                if (rule.isLineComment) {
                    return
                } else if (rule.variable === true) {
                    //  var name;
                    name = rule.name.substr(1);

                    var value = rule.value;
                    lessVars["@" + name] = value.toCSS(options);

                    console.log(name + " : " + value.toCSS(options))
                } else {
                    parseSketchRule(rule, null, [])
                }
            });
            //console.log("----------------------------------------")
            //console.log(lessVars)

            // completed            
            console.log("Completed")
            saveData(sketchRules, pathToJSON)
            console.log("Saved JSON")
            if (pathToResultVars != undefined) {
                saveData(lessVars, pathToResultVars)
            }
        });
    } catch (e) {
        console.log("Failed to parse LESS with error message:\n")
        console.log(e.message)
        process.exit(-1)
    }

    console.log(sketchRules)


    console.log("Read LESS: done")
}


function parseSketchRule(rule, elements, path) {

    // save info about enabled mixins to ignore them
    if (rule._lookups && Object.keys(rule._lookups).length > 0) {
        Object.keys(rule._lookups).forEach(function (s) {
            _lookups[s.trim()] = true
        })
    }

    if (null != elements) {
        var foundMixin = false
        elements.forEach(function (el) {
            path = path.concat([el.value])
            if (el.value in _lookups) {
                foundMixin = true
                return
            }
        })
        if (foundMixin) return
    } else {
        if (rule.selectors != null && rule.selectors.length > 0) {
            rule.selectors.forEach(function (sel) {
                parseSketchRule(rule, sel.elements, path)
            })
            return
        }
    }
    ///
    if (rule.rules && rule.rules.length > 0) {
        if (!(rule.rules[0].rules)) {
            saveSketchRule(rule, path)
        } else {
            rule.rules.forEach(function (oneRule) {
                parseSketchRule(oneRule, null, path)
            })
        }
    }
}

function saveSketchRule(rule, path) {
    var sketchPath = path.join("/")
    //sketchPath = sketchPath.replace(/(\.)/g, '').replace(/^\./,'')    

    const sketchRule = {
        path: path,
        props: {
            __tokens: {}
        }
    }
    rule.rules.forEach(function (oneRule, index) {
        if (oneRule.isLineComment) return
        if (null != oneRule.selectors) {
            parseSketchRule(oneRule, null, path)
            return
        }

        var value = oneRule.value.toCSS(parseOptions);

        // get token from rule comment
        var token = ''
        var nextRule = rule.rules[index + 1]
        if (nextRule != null && nextRule.isLineComment) {
            var res = nextRule.value.match(/!{1}([\w-]*)!{1}/)
            if (null != res && null != res[1]) {
                token = '@' + res[1]
            }
        }


        sketchRule.props[String(oneRule.name)] = value
        if (token != '') sketchRule.props.__tokens[token] = true
    })
    sketchRules.push(sketchRule)
}



function saveData(data, pathToJSON) {
    var json = JSON.stringify(data, null, '    ')

    if (pathToJSON && pathToJSON != '') {
        fs.writeFileSync(pathToJSON, json, 'utf8');
    } else {
        console.log(json)
    }

    return true
}

function _getPathToNodeModules() {
    var result = require('child_process').execSync("node /usr/local/bin/npm -g root", { env: process.env.PATH })
    var path = result.toString().replace("\n", "")
    return path
}


function transformCustomLESStoCSS(pathToOrgLess, pathToCSS) {
    const pathToCustomLess = pathToOrgLess.replace(".less", ".css.less")

    // Check file existing
    if (!fs.existsSync(pathToCustomLess)) {
        // no file with name <LESS_FILE>.css.less
        return true
    }

    // Convert LESS to pure CSS and save it to CSS file
    const result = require('child_process').execSync("node /usr/local/bin/lessc " + pathToCustomLess + " > " + pathToCSS, { env: process.env.PATH })
    console.log("Rendered CSS LESS to CSS: " + pathToCSS)
}