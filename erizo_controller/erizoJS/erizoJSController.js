/*global require, exports, , setInterval, clearInterval*/

var addon = require('./../../erizoAPI/build/Release/addon');
var logger = require('./../common/logger').logger;
var amqper = require('./../common/amqper');

// Logger
var log = logger.getLogger("ErizoJSController");

exports.ErizoJSController = function (spec) {
    "use strict";

    var that = {},
        // {id: {subsId1: wrtc1, subsId2: wrtc2}}
        subscribers = {},
        // {id: {muxer: OneToManyProcessor, wrtc: WebRtcConnection}
        publishers = {},

        // {id: ExternalOutput}
        externalOutputs = {},

        INTERVAL_TIME_SDP = 100,
        INTERVAL_TIME_KILL = 30*60*1000, // Timeout to kill itself after a timeout since the publisher leaves room.
        SLIDESHOW_TIME = 1000,
        initWebRtcConnection,
        getSdp,
        getRoap,
        setSlideShow;


    var CONN_INITIAL = 101, CONN_STARTED = 102,CONN_GATHERED = 103, CONN_READY = 104, CONN_FINISHED = 105, CONN_CANDIDATE = 201, CONN_SDP = 202, CONN_FAILED = 500;




    /*
     * Enables/Disables slideshow mode for a subscriber
     */
    setSlideShow = function (slideShowMode, from, to){
        log.info("Setting SlideShow", slideShowMode, from, to);
        
        var theWrtc = subscribers[to][from];
        if (slideShowMode ===true){
            theWrtc.setSlideShowMode(true);
            theWrtc.slideShowMode = true;
            var wrtcPub = publishers[to].wrtc;
            if (wrtcPub.periodicPlis===undefined){
                wrtcPub.periodicPlis = setInterval(function (){
                    if(wrtcPub)
                        wrtcPub.generatePLIPacket();
                }, SLIDESHOW_TIME);
            }
        }else{
            var wrtcPub = publishers[to].wrtc;
            wrtcPub.generatePLIPacket(); 
            theWrtc.setSlideShowMode(false);
            theWrtc.slideShowMode = false;
            if (publishers[to].wrtc.periodicPlis!==undefined){
                for (var i in subscribers[to]){
                    if(subscribers[to][i].slideShowMode === true){
                        return;
                    }
                }

                log.debug("Clearing Pli interval as no more slideshows subscribers are present");
                clearInterval(publishers[to].wrtc.periodicPlis);
                publishers[to].wrtc.periodicPlis = undefined;
            }
        }

    }



    /*
     * Given a WebRtcConnection waits for the state CANDIDATES_GATHERED for set remote SDP.
     */
    initWebRtcConnection = function (wrtc, callback, id_pub, id_sub, options) {
        log.debug("Initing WebRTC Connection, minVideoBW", wrtc.minVideoBW);

        if (wrtc.minVideoBW){
            var monitorMinVideoBw = {};
            if (wrtc.scheme){
                try{
                    monitorMinVideoBw = require("./adapt_schemes/"+wrtc.scheme).MonitorSubscriber(log);
                } catch (e){
                    log.warn("Could not find adapt_scheme script, will use notify");
                    monitorMinVideoBw = require("./adapt_schemes/notify").MonitorSubscriber(log);
                }
            }else{
                monitorMinVideoBw = require("./adapt_schemes/notify").MonitorSubscriber(log);
            }
            monitorMinVideoBw(wrtc, callback);
        }

        if (GLOBAL.config.erizoController.report.rtcp_stats) {
            log.debug("RTCP Stats Active");
            wrtc.getStats(function (newStats){
                var timeStamp = new Date();
                amqper.broadcast('stats', {pub: id_pub, subs: id_sub, stats: JSON.parse(newStats), timestamp:timeStamp.getTime()});
            });
        }

        wrtc.init( function (newStatus, mess){
            log.debug("webrtc Addon status ", newStatus, mess, "id pub", id_pub, "id_sub", id_sub );

            if (GLOBAL.config.erizoController.report.connection_events) {
                var timeStamp = new Date();
                amqper.broadcast('event', {pub: id_pub, subs: id_sub, type: 'connection_status', status: newStatus, timestamp:timeStamp.getTime()});
            }

            switch(newStatus) {
                case CONN_INITIAL:
                    callback('callback', {type: 'started'});
                    break;

                case CONN_SDP:
                case CONN_GATHERED:
                    log.debug('Sending SDP', mess);
                    mess = mess.replace(that.privateRegexp, that.publicIP);
                    if (options.createOffer)
                        callback('callback', {type: 'offer', sdp: mess});
                    else
                        callback('callback', {type: 'answer', sdp: mess});
                    break;

                case CONN_CANDIDATE:
                    mess = mess.replace(that.privateRegexp, that.publicIP);
                    callback('callback', {type: 'candidate', candidate: mess});
                    break;

                case CONN_FAILED:
                    log.warn("Connection id_pub:", id_pub, "idsub:",id_sub,"failed the ICE process");
                    callback('callback', {type: 'failed', sdp: mess});
                    break;

                case CONN_READY:
                    log.info("Connection id_pub:", id_pub, "idsub:",id_sub,"ready");
                    // If I'm a subscriber and I'm bowser, I ask for a PLI
                    if (id_sub && options.browser === 'bowser') {
                        log.debug('SENDING PLI from ', id_pub, ' to BOWSER ', id_sub);
                        publishers[id_pub].wrtc.generatePLIPacket();
                    }
                    if (options.slideShowMode == true){
                        setSlideShow(true, id_sub, id_pub);
                    }
                    callback('callback', {type: 'ready'});
                    break;
            }
        });
        log.info("initializing");
        if (options.createOffer===true){
            log.info("Creating Offer");
            wrtc.createOffer();
        }
        callback('callback', {type: 'initializing'});
    };

    /*
     * Gets SDP from roap message.
     */
    getSdp = function (roap) {

        var reg1 = new RegExp(/^.*sdp\":\"(.*)\",.*$/),
            sdp = roap.match(reg1)[1],
            reg2 = new RegExp(/\\r\\n/g);

        sdp = sdp.replace(reg2, '\n');

        return sdp;

    };

    /*
     * Gets roap message from SDP.
     */
    getRoap = function (sdp, offerRoap) {

        var reg1 = new RegExp(/\n/g),
            offererSessionId = offerRoap.match(/("offererSessionId":)(.+?)(,)/)[0],
            answererSessionId = "106",
            answer = ('\n{\n \"messageType\":\"ANSWER\",\n');

                sdp = sdp.replace(reg1, '\\r\\n');

                //var reg2 = new RegExp(/^.*offererSessionId\":(...).*$/);
                //var offererSessionId = offerRoap.match(reg2)[1];

                answer += ' \"sdp\":\"' + sdp + '\",\n';
                //answer += ' \"offererSessionId\":' + offererSessionId + ',\n';
                answer += ' ' + offererSessionId + '\n';
                answer += ' \"answererSessionId\":' + answererSessionId + ',\n \"seq\" : 1\n}\n';

                return answer;
    };

    that.addExternalInput = function (from, url, callback) {

        if (publishers[from] === undefined) {

            log.info("Adding external input peer_id ", from);

            var muxer = new addon.OneToManyProcessor(),
                ei = new addon.ExternalInput(url);

            publishers[from] = {muxer: muxer};
            subscribers[from] = {};

            ei.setAudioReceiver(muxer);
            ei.setVideoReceiver(muxer);
            muxer.setExternalPublisher(ei);

            var answer = ei.init();

            if (answer >= 0) {
                callback('callback', 'success');
            } else {
                callback('callback', answer);
            }

        } else {
            log.info("Publisher already set for", from);
        }
    };

    that.addExternalOutput = function (to, url) {
        if (publishers[to] !== undefined) {
            log.info("Adding ExternalOutput to " + to + " url " + url);
            var externalOutput = new addon.ExternalOutput(url);
            externalOutput.init();
            publishers[to].muxer.addExternalOutput(externalOutput, url);
            externalOutputs[url] = externalOutput;
        }
    };

    that.removeExternalOutput = function (to, url) {
        if (externalOutputs[url] !== undefined && publishers[to] !== undefined) {
            log.info("Stopping ExternalOutput: url " + url);
            publishers[to].muxer.removeSubscriber(url);
            delete externalOutputs[url];
        }
    };

    that.processSignaling = function (streamId, peerId, msg) {
        log.info("Process Signaling message: ", streamId, peerId, msg);
        if (publishers[streamId] !== undefined) {
            if (subscribers[streamId][peerId]) {
                if (msg.type === 'offer') {
                    subscribers[streamId][peerId].setRemoteSdp(msg.sdp);
                } else if (msg.type === 'candidate') {
                    subscribers[streamId][peerId].addRemoteCandidate(msg.candidate.sdpMid, msg.candidate.sdpMLineIndex , msg.candidate.candidate);
                } else if (msg.type === 'updatestream'){
                    if(msg.sdp)
                        subscribers[streamId][peerId].setRemoteSdp(msg.sdp);
                    if (msg.config){
                        if (msg.config.slideShowMode!==undefined){
                            setSlideShow(msg.config.slideShowMode, peerId, streamId)
                        }
                    }
                }
            } else {
                if (msg.type === 'offer') {
                    publishers[streamId].wrtc.setRemoteSdp(msg.sdp);
                } else if (msg.type === 'candidate') {
                    publishers[streamId].wrtc.addRemoteCandidate(msg.candidate.sdpMid, msg.candidate.sdpMLineIndex, msg.candidate.candidate);
                } else if (msg.type === 'updatestream'){
                    if (msg.sdp){
                        publishers[streamId].wrtc.setRemoteSdp(msg.sdp);
                    }
                    if (msg.config){
                        if (msg.config.minVideoBW){
                            log.debug("Updating minVideoBW to ", msg.config.minVideoBW);
                            publishers[streamId].minVideoBW = msg.config.minVideoBW;
                            for (var sub in subscribers[streamId]){
                                log.debug("sub", sub);
                                log.debug("updating subscriber BW from", subscribers[streamId][sub].minVideoBW, "to", msg.config.minVideoBW*1000 );
                                var theConn = subscribers[streamId][sub];
                                theConn.minVideoBW = msg.config.minVideoBW*1000; // We need it in bps
                                theConn.lowerThres = Math.floor(theConn.minVideoBW*(1-0.2));
                                theConn.upperThres = Math.ceil(theConn.minVideoBW*(1+0.1));
                            }
                        }
                    }
                }
            }

        }
    };

    /*
     * Adds a publisher to the room. This creates a new OneToManyProcessor
     * and a new WebRtcConnection. This WebRtcConnection will be the publisher
     * of the OneToManyProcessor.
     */
    that.addPublisher = function (from, options, callback) {

        if (publishers[from] === undefined) {

            log.info("Adding publisher peer_id ", from, "minVideoBW", options.minVideoBW,"adaptation scheme", options.scheme);

            var muxer = new addon.OneToManyProcessor(),
                wrtc = new addon.WebRtcConnection(true, true, GLOBAL.config.erizo.stunserver, GLOBAL.config.erizo.stunport, GLOBAL.config.erizo.minport, GLOBAL.config.erizo.maxport,false,
                        GLOBAL.config.erizo.turnserver, GLOBAL.config.erizo.turnport, GLOBAL.config.erizo.turnusername, GLOBAL.config.erizo.turnpass);

            publishers[from] = {muxer: muxer, wrtc: wrtc, minVideoBW: options.minVideoBW, scheme:options.scheme};
            subscribers[from] = {};

            wrtc.setAudioReceiver(muxer);
            wrtc.setVideoReceiver(muxer);
            muxer.setPublisher(wrtc);

            initWebRtcConnection(wrtc, callback, from, undefined, options);

        } else {
            if (Object.keys(subscribers[from]).length === 0){
                log.warn("Publisher already set for", from, "but no subscribers, will republish");
                var wrtc = new addon.WebRtcConnection(true, true, GLOBAL.config.erizo.stunserver, GLOBAL.config.erizo.stunport, GLOBAL.config.erizo.minport, GLOBAL.config.erizo.maxport,false,
                        GLOBAL.config.erizo.turnserver, GLOBAL.config.erizo.turnport, GLOBAL.config.erizo.turnusername, GLOBAL.config.erizo.turnpass);
                var muxer = publishers[from].muxer;
                publishers[from].wrtc = wrtc;
                wrtc.setAudioReceiver(muxer);
                wrtc.setVideoReceiver(muxer);
                muxer.setPublisher(wrtc);
                
                initWebRtcConnection(wrtc, callback, from, undefined, options);
            }else{
                log.warn("Publisher already set for", from, "and has subscribers, ignoring");
            }
        }
    };

    /*
     * Adds a subscriber to the room. This creates a new WebRtcConnection.
     * This WebRtcConnection will be added to the subscribers list of the
     * OneToManyProcessor.
     */
    that.addSubscriber = function (from, to, options, callback) {

        if (publishers[to] === undefined){ 
            log.warn("Trying to subscribe ", from, " to unavailable publisher", to);
            //We may need to notify the clients 
            return;
        }
        if (subscribers[to][from] !== undefined){
            log.warn("This subscription from", from, "to", to, "is already made, will remove it first and resubscribe");
            that.removeSubscriber(from,to);
        }

        log.info("Adding subscriber from ", from, 'to ', to, 'audio', options.audio, 'video', options.video);

        var wrtc = new addon.WebRtcConnection(true, true, GLOBAL.config.erizo.stunserver, GLOBAL.config.erizo.stunport, GLOBAL.config.erizo.minport, GLOBAL.config.erizo.maxport,false,
                GLOBAL.config.erizo.turnserver, GLOBAL.config.erizo.turnport, GLOBAL.config.erizo.turnusername, GLOBAL.config.erizo.turnpass);

        subscribers[to][from] = wrtc;
        publishers[to].muxer.addSubscriber(wrtc, from);
        wrtc.minVideoBW = publishers[to].minVideoBW;
        log.debug("Setting scheme to sub WRTC", publishers[to].scheme);
        wrtc.scheme = publishers[to].scheme;
        initWebRtcConnection(wrtc, callback, to, from, options);
    };

    /*
     * Removes a publisher from the room. This also deletes the associated OneToManyProcessor.
     */
    that.removePublisher = function (from) {

        if (subscribers[from] !== undefined && publishers[from] !== undefined) {
            log.info('Removing muxer (publisher)', from);
            if(publishers[from].periodicPlis!==undefined){
                log.debug("Clearing periodic PLIs for publisher");
                clearInterval (publishers[from].periodicPlis);
            }
            for (var key in subscribers[from]) {
                if (subscribers[from].hasOwnProperty(key)){
                    subscribers[from][key].close();
                }
            }
            publishers[from].wrtc.close();
            publishers[from].muxer.close(function(message){
                log.info("Muxer finished closing", message);
                delete subscribers[from];
                delete publishers[from];
                var count = 0;
                for (var k in publishers) {
                    if (publishers.hasOwnProperty(k)) {
                        ++count;
                    }
                }
                log.debug("Remaining publishers: ", count);
                if (count === 0)  {
                    log.info('Removed all publishers. Killing process.');
                    process.exit(0);
                }
            });

        } else {
            log.warn("Trying to remove publisher", from, "that doesn't exist here");
        }
    };

    /*
     * Removes a subscriber from the room. This also removes it from the associated OneToManyProcessor.
     */
    that.removeSubscriber = function (from, to) {

        if (subscribers[to][from]) {
            log.info('Removing subscriber ', from, 'to muxer ', to);
            subscribers[to][from].close();
            publishers[to].muxer.removeSubscriber(from);
            delete subscribers[to][from];
        }

        if (publishers[to].wrtc.periodicPlis!==undefined){
            for (var i in subscribers[to]){
                if(subscribers[to][i].slideShowMode === true){
                    return;
                }
            }
            log.debug("Clearing Pli interval as no more slideshows subscribers are present");
            clearInterval(publishers[to].wrtc.periodicPlis);
            publishers[to].wrtc.periodicPlis = undefined;
        }
    };

    /*
     * Removes all the subscribers related with a client.
     */
    that.removeSubscriptions = function (from) {

        var key;

        log.info('Removing subscriptions of ', from);
        for (key in subscribers) {
            if (subscribers.hasOwnProperty(key)) {
                if (subscribers[to][from]) {
                    log.info('Removing subscriber ', from, 'to muxer ', key);
                    publishers[key].muxer.removeSubscriber(from);
                    delete subscribers[key][from];
                }
            }
        }
    };

    return that;
};
