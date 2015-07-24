var kue = require('kue'),
  koop = require('koop/lib'),
  FeatureService = require('../models/FeatureService'),
  pgcache = require('koop-pgcache'),
  config = require('config');

// Init Koop with things it needs like a log and Cache 
koop.log = new koop.Logger( config );
koop.Cache = new koop.DataCache( koop );

// registers a DB modules  
koop.Cache.db = pgcache.connect( config.db.conn, koop );

// Create the job queue for this worker process
// connects to the redis same redis
var jobs = kue.createQueue({
  prefix: config.redis.prefix,
  redis: {
    port: config.redis.port,
    host: config.redis.host
  }
});

process.once( 'SIGINT', function ( sig ) {
  jobs.active(function(err, ids){
    if ( ids.length ){
      ids.forEach( function( id ) {
        kue.Job.get( id, function( err, job ) {
          job.inactive();
          jobs.active(function(err, activeIds){
            if (!activeIds.length){
             jobs.shutdown(function(err) {
               process.exit( 0 );
             }, 5000 );
            }
          });
        });
      });
    } else {
      jobs.shutdown(function(err) {
        process.exit( 0 );
      }, 5000 );
    }
  });
});

jobs.process('agol', function(job, done){
  makeRequest(job, done);
});


setInterval(function () {
  if (typeof gc === 'function') {
    gc();
  }
}, 5000);


// makes the request to the feature service and inserts the Features
function makeRequest(job, done){
  var domain = require('domain').create();

  domain.on('error', function(err){
    done(err);
  });

  domain.run(function(){
    console.log('starting job', job.id, job.data.itemId + '/' + job.data.layerId);
    var completed = 0, len = job.data.pages.length;
    var featureService = new FeatureService(job.data.serviceUrl, {});

    // aggregate responses into one json and call done we have all of them 
    // start the requests
    featureService.pageQueue.push(job.data.pages, function (error, json) {
      if (error) {
        featureService.pageQueue.kill();
        return done(error || 'Feature page JSON is undefined');
      }

      if (json) {
        if (json.error) {
          featureService.pageQueue.kill();
          return done(json.error.details[0]);
        }

        // insert a partial
        koop.GeoJSON.fromEsri(job.data.fields || [], json, function (err, geojson) {
          // concat the features so we return the full json
          koop.Cache.insertPartial( 'agol', job.data.itemId, geojson, job.data.layerId, function (err) {

            completed++;
            console.log(completed, len, job.data.itemId);
            job.progress( completed, len );

            if (completed === len) {
              var key = ['agol', job.data.itemId, job.data.layerId ].join(':');
              koop.Cache.getInfo(key, function(err, info){
                if (err){
                  return done(err);
                }

                if (info && info.status) {
                  delete info.status;
                }

                koop.Cache.updateInfo(key, info, function(err, info){
                  return done();
                });
              });
            }
          });
        });
      }
    });
  });

}

