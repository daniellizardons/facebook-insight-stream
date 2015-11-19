// doc: this module is a facebook-insights read stream built over node readable stream
// it provide stream api to read insights data from facebook accounts,
// currently supporting only pages-insight and app-insights.

module.exports = FacebookInsightStream;

var util = require( "util" );
var sugar = require( "sugar" );
var stream = require( "stream" );
var request = require( "request" );
var Promise = require( "bluebird" );

request = Promise.promisifyAll( request )

var BASEURL = "https://graph.facebook.com/v2.5";

//edge url for each node type
var EDGEMAP = {
    page: "insights",
    app: "app_insights",
}

util.inherits( FacebookInsightStream, stream.Readable )
function FacebookInsightStream( options ) {

    stream.Readable.call( this, { objectMode: true } );

    options.edge = EDGEMAP[ options.node ];
    this.options = options;

}

// _read will be called once for each collected item
FacebookInsightStream.prototype._read = function ( ) {

    if ( ! this.items ) {
        return this._init( this._read.bind( this ) )
    }

    if ( ! this.items.length ) {
        return this.push( null )
    }
    var metrics = this.options.metrics.clone();
    var item = this.items.shift();

    this._collect( metrics, item, {} )
        .then( this.push.bind( this ) )
}

FacebookInsightStream.prototype._init = function ( callback ) {
    var options = this.options; 

    // building url pattern for all the request
    var until = Date.now();
    var since = new Date();
    since = since.setDate( since.getDay() - options.pastdays )

    // fb ask for timestamp in seconds
    until = Math.round( until / 1000 );
    since = Math.round( since / 1000 );

    var path = [ 
        BASEURL,
        "{id}",
        options.edge,
        "{metric}",
    ].join( "/" )

    var query = [
        "access_token=" + options.token,
        "period=" + options.period,
        "since=" + since,
        "until=" + until,
    ].join( "&" )

    // this url is urlPattern shared by all the requests
    // each request using thie pattern should replace the 
    // {id} and {metric} place holders with real values  
    this.url = [ path, query ].join( "?" )

    // options.itemlist can be either array of items or
    // promise that resolved with array of items 
    Promise.resolve( options.itemList )
        .bind( this )
        .map( this._initItem, { concurrency: 3 } )
        .then( function ( items ) {
            this.items = items;
            this.total = items.length;
            this.loaded = 0;
            callback();
        })
        .catch( this.emit.bind( this, "error" ) )
}

FacebookInsightStream.prototype._initItem = function ( item ) {
    var options = this.options;
    var model = {
        base: BASEURL,
        id: item,
        token: options.token
    };

    var url = strReplace( "{base}/{id}?access_token={token}", model )
    
    var title = "FACEBOOK " + options.node.toUpperCase();
    console.log( new Date().toISOString(), title, url )
    
    return request.getAsync( url )
        .get( 1 )
        .then( JSON.parse )
        .then( errorHandler )
        .then( function ( data ) {
            return {
                id: item,
                name: data.name
            }
        })
}

// _collect will be called once for each metric, the insight api request
// single api call for each metric, wich result in a list of values ( value per day)
// so in attempt to create one table with all the metrics,
// we are buffering each result in a key value map, with key for 
// each day in the collected time range, and appending each value
// of the current metric to the appropriate key in the buffer.
// finally we generating single row for each day.

FacebookInsightStream.prototype._collect = function ( metrics, item, buffer ) {
    var options = this.options;
    // done with the current item
    if ( ! metrics.length ) {
        var data = Object.keys( buffer ).map( function ( end_time ) {
            var row = buffer[ end_time ];
            row.date = end_time;
            row[ options.node + "Id" ] = item.id;
            row[ options.node + "Name" ] = item.name;
            return row;
        })

        this.emit( "progress", {
            total: this.total,
            loaded: ++this.loaded,
            message: "{{remaining}} " + options.node + "s remaining" 
        })
        return data;
    }

    var _metric = metrics.shift();
    var model = { id: item.id, metric: _metric }
    var url = strReplace( this.url, model );
    var title = "FACEBOOK " + options.node.toUpperCase();

    console.log( new Date().toISOString(), title, url )

    return request.getAsync( url )
        .get( 1 )
        .then( JSON.parse )
        .then( errorHandler )
        .get( "data" )
        .bind( this )
        .then( function ( data ) {
            // in case that there is no data for a given metric
            // we will skip to the next metric
            if ( ! data.length ) {
                var error = new Error( "No data found for the metric " + _metric );
                error.skip = true;
                throw error;
            }
            // in app insight the returned data is list of values
            // in page insight its object that include the list of values
            return data[ 0 ].values || data
        })
        .each( function ( val ) {
            var time = val.end_time || val.time;
            buffer[ time ] || ( buffer[ time ] = {} )
            buffer[ time ][ _metric ] = val.value;
        })
        .then( function () {
            return this._collect( metrics, item, buffer );
        })
        .catch( function ( error ) {
            if ( error.skip ) {
                return this._collect( metrics, item, buffer )
            } else {
                this.emit( "error", error )
            }
        })
}

function errorHandler ( body )  {
    if ( body.error ) {
        throw new Error( body.error.message )
    } else {
        return body
    }
}

function strReplace ( string, model ) {
    Object.keys( model ).each( function ( name ) {
        string = string.replace( "{" + name + "}", model[ name ] );
    })

    return string;
}