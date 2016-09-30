import FrameResolver from "./resolve-frame"
import RoundTripMessageWrapper from "./RoundTripMessageWrapper"

var wrapper = new RoundTripMessageWrapper(self, "ResolveFrameWorker")
var frameResolver = new FrameResolver();

setTimeout(function(){
    wrapper.send("fetchUrl", "http://localhost:1234/demos/backbone-todomvc/index.html", function(){
        console.warn("response", arguments)
    });
}, 500)

wrapper.on("resolveFrame", function(frameString, callback){
    frameResolver.resolve(frameString, function(err, res){
        callback(err, res)
    })
})

wrapper.on("registerDynamicFiles", function(files, callback){
    frameResolver.addFilesToCache(files)
    callback()
})

wrapper.on("getSourceFileContent", function(path, callback){
    frameResolver.getSourceFileContent(path, callback)
})
