/*
 * Copyright (c) 2015-2016 PointSource, LLC.
 * MIT Licensed
 */
var tv4 = require('tv4'),
    formats = require('tv4-formats'),
    _ = require('lodash');

tv4.addFormat(formats);


exports.validateParameterType = function (schema, value) {

    //Since data will be coming in from a query parameter, it comes in as a string
    //rather than a JSON object.  So we do our best to cast it to the desired type.
    value = castValueFromString(schema, value);

    var result = tv4.validateMultiple(value, schema);
    return result;
};

exports.validateJSONType = function (schema, value) {
    var result = tv4.validateMultiple(value, schema);
    return result;
};

function castValueFromString(schema, value) {
    if (schema.type === 'number' || schema.type === 'integer') {
        var orig = value;
        value = Number(value); //cast
        //if value can't be cast to a number, return the original string
        //which will let tv4 create an appropriate error
        if (isNaN(value)) {
            return orig;
        }
    }

    if (schema.type === 'boolean') {
        if (value === 'true') {
            value = true;
        } else if (value === 'false') {
            value = false;
        }
    }

    if (schema.type === 'array') {
        var format = schema.collectionFormat || 'csv';

        //value could already be an array, for example if it was defined 
        //as a default value in the swagger schema
        if (!_.isArray(value)) {
            value = parseArray(value, format);
        }
        for (var i = 0; i < value.length; i++) {
            value[i] = castValueFromString(schema.items, value[i]);
        }
    }

    return value;
}

exports.cast = castValueFromString;


function parseArray(str, format) {

    //str should be an array since multiple query params of the same name were used, e.g. foo=bar1&foo=bar2
    if (format === 'multi') {
        return _.isArray(str) ? str : [str];
    }

    var splitChar = {
        'csv': ',',
        'ssv': ' ',
        'tsv': '\t',
        'pipes': '|'
    }[format];

    return str.split(splitChar);
}