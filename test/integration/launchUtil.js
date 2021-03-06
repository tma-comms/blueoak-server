/*
 * Copyright (c) 2015-2016 PointSource, LLC.
 * MIT Licensed
 */
var path = require('path'),
    child_process = require('child_process');

var lastLaunch = null;

exports.launch = function (fixtureName, opts, done) {

    //opts is optional
    if (!done) {
        done = opts;
        opts = {};
    }
    if (!opts.exec) {
        opts.exec = '../../bin/blueoak-server.js';
    }

    var output = '';
    lastLaunch = child_process.execFile(path.resolve(__dirname, opts.exec), [],
        {
            'cwd': path.resolve(__dirname, 'fixtures/' + fixtureName),
            'env': opts.env
        },
        function (err, stdout, stderr) {
            if (err) {
                console.warn(err, stderr);
            }
            output += stdout + stderr;
        });
    setTimeout(function () {
        output = output.length > 50 ? output : null; //if output > 50, probably contains a stack tracegu
        done(output);
    }, 4000);
};

exports.finish = function (done) {
    lastLaunch.kill('SIGINT');
    setTimeout(function () {
        done();
    }, 2500);
};
