var async = require("./async");
var ErrorStackParser = require("./error-stack-parser")
var StackTraceGPS = require("./stacktrace-gps")
var _ = require("underscore")

var gps;

function resolveStackArray(stackArray, callback){
    var unfilteredStackArray = stackArray
    stackArray = stackArray.filter(function(frame){
        if (frame.indexOf("string-trace.js") !== -1) {
            return false;
        }
        if (frame.indexOf("(native)") !== -1) {
            return false;
        }
        if (frame === "Error"){
            return false;
        }
        return true
    })

    var allCodeIsPartOfStringTrace = stackArray.length === 0;
    if (allCodeIsPartOfStringTrace){
        callback(null, unfilteredStackArray)
        return;
    }

    var str = stackArray.join("\n")

    var err = ErrorStackParser.parse({stack: str});



    function resFrame(frame, callback){
        gps._get(frame.fileName).then(function(src){
            var lines = src.split("\n")
            frame.prevLine = lines[frame.lineNumber - 1 - 1]// adjust for lines being one-indexed
            frame.nextLine = lines[frame.lineNumber + 1 - 1]
            frame.line = lines[frame.lineNumber - 1];

            callback(null, JSON.parse(JSON.stringify(frame)))
        })

    }

    async.map(err, function(frame, callback){
        gps.pinpoint(frame).then(function(newFrame){

            resFrame(newFrame, callback)
        }, function(){
            resFrame(frame, callback)
            console.log("error", arguments)
        });
    }, function(err, newStackFrames){
        callback(newStackFrames)
    })
}

function resolveStacksInOrigin(origin, callback){
    var functionsToCall = []
    if (origin.stack){
        functionsToCall.push(function(callback){
            resolveStackArray(origin.stack, function(newStack){
                origin.resolvedStack = newStack
                callback()
            })
        })
    }
    if (origin.inputValues) {
        functionsToCall.push(function(callback){
            async.each(origin.inputValues, function(iv, callback){
                if (!iv) {callback();}
                else {
                    resolveStacksInOrigin(iv, callback)
                }
            }, function(){
                callback();
            })
        })
    }


    async.series(functionsToCall, function(){
        callback();
    })

}

function isElement(value){
    return value instanceof Element
}

function resolveStackIfAvailable(data, callback){
    if (data.stack){
        resolveStackArray(data.stack, function(resolvedStack){
            data = _.clone(data);
            data.resolvedStack = resolvedStack;
            callback(null, data)
        })
    } else {
       callback(null, data)
    }
}

function resolveInputValue(inputValue, callback){
    if (isElement(inputValue)){
        getElementOriginData(inputValue, function(data){
            callback(null, data)
        })
    } else {
        var origin
        if (inputValue.origin){
            // i never experienced this branch in the wild, i don't think it makes sense to have it
            origin = _.clone(inputValue.origin);
            console.log("A", inputValue)
        } else {
            console.log("B")
            origin = _.clone(inputValue);
        }
        resolveStacksInOrigin(origin, function(){
            callback(null, origin)
        })
    }
}

function convertElOrigin(elOrigin, callback){
    elOrigin.value = elOrigin.getValue();

    async.map(elOrigin.inputValues, resolveInputValue,  function(err, resolvedInputValues){
        elOrigin = _.clone(elOrigin)
        elOrigin.inputValues = resolvedInputValues;

        resolveStackIfAvailable(elOrigin, function(err, elOrigin){
            callback(null, elOrigin)
        })
    })
}
function getElementOriginData(el, callback){
    if (!el.__elOrigin && !el.__elOriginCreation){
        console.warn("no elorigin for", el)
        callback({action: "no el origin"});
        return;
    }

    var elOrigins = el.__elOrigin;
    if (!elOrigins) {
        elOrigins = []
    }
    async.map(elOrigins, convertElOrigin, function(err, convertedElOrigins){
        var inputValues = []
        if (el.__elOriginCreation) {
            inputValues.push(el.__elOriginCreation)
        }
        inputValues = inputValues.concat(convertedElOrigins)
        var data = {
            actionDetails: el.tagName,
            stack: undefined,
            action: "Element",
            value: el.outerHTML,
            inputValues: inputValues
        }
        resolveStackIfAvailable(data, function(err, data){
            callback(data)
        })
    })
}

setTimeout(function(){
    var sourceCache = {};
    var fnEls = document.getElementsByClassName("string-trace-fn")
    fnEls = Array.prototype.slice.call(fnEls)
    fnEls.forEach(function(el){
        var key = el.getAttribute("fn") + ".js"
        sourceCache[key] = el.innerHTML
    })

    gps = new StackTraceGPS({sourceCache: sourceCache});

    window.JSON.parse = window.nativeJSONParse
    console.time("Get visData")
    getElementOriginData(document.body, function(oooo){

        window.oooo = oooo;
        console.timeEnd("Get visData")
        localStorage.setItem("visData", JSON.stringify(oooo))
        gps = null;
        console.log("got oooo, saved to localstorage")
    })
}, 2000)
