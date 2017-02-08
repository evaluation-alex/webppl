'use strict';
'use ad';

var _ = require('lodash');
var util = require('../util');
var paramStruct = require('../params/struct');
var Trace = require('../trace');
var guide = require('../guide');

// This estimator makes the following assumptions:

// 1. The model contains exactly one `mapData`.

// 2. Either a) each element of the data array is observed (passed to
// `observe` as its second argument) exacly once in the corresponding
// observation function, or b) each element of the data array is
// itself an array, of which each element is observed exaclty once,
// and in the order in which they appear in the array. See below for
// examples of each of these.

// var model = function() {
//   mapData({data: [x, y]}, function(datum) {
//     // latent random choices
//     observe(dist, datum);
//   });
// };

// var model = function() {
//   mapData({data: [[x1, y1], [x2, y2]]}, function(arr) {
//     // latent random choices
//     observe(dist, arr[0]);
//     observe(dist, arr[1]);
//   });
// };


// I assume that we have one of these schemes, that is data doesn't
// contain a mixture of both.

module.exports = function(env) {

  // --------------------------------------------------
  // Coroutine to hallucinate data.
  // --------------------------------------------------
  function sampleFantasyCoroutine(wpplFn, s, a, cont) {
    this.wpplFn = wpplFn;
    this.s = s;
    this.a = a;
    this.cont = cont;

    // A 'record' stores the fantasized data.
    var trace = new Trace(this.wpplFn, s, env.exit, a);
    this.record = {trace: trace, data: []};

    this.insideMapData = false;

    this.coroutine = env.coroutine;
    env.coroutine = this;
  }

  sampleFantasyCoroutine.prototype = {

    run: function() {
      return this.wpplFn(_.clone(this.s), function(s, val) {
        env.coroutine = this.coroutine;
        return this.cont(this.record);
      }.bind(this), this.a);
    },

    sample: function(s, k, a, dist, options) {
      var sampleFn = this.insideMapData ? this.sampleLocal : this.sampleGlobal;
      return sampleFn.call(this, s, a, dist, options, function(s, val) {
        // TODO: Do we really need to use a full trace here. Could we
        // not just use an object to map from addresses to sampled
        // values? (Also need to track score?)
        this.record.trace.addChoice(dist, val, a, s, k, options);
        return k(s, val);
      }.bind(this));
    },

    sampleLocal: function(s, a, targetDist, options, k) {
      // TODO: Update targetScore? (Also see observe.) Would this fit
      // better in the estimator phase? (I guess there's a reason it's
      // not already there?)
      return k(s, targetDist.sample());
    },

    sampleGlobal: function(s, a, dist, options, k) {
      return guide.getDist(
        options.guide, options.noAutoGuide, dist, env, s, a,
        function(s, guideDist) {
          if (!guideDist) {
            throw new Error('dream: No guide distribution specified.');
          }
          return k(s, guideDist.sample());
        });
    },

    factor: function(s, k, a) {
      // TODO: Update the trace score here?
      // Double check it makes sense to support factor statements in
      // dream. Mention in comments at top-level either way.
      return k(s);
    },

    observe: function(s, k, a, dist) {
      // I suspect that the current implementation doesn't support
      // observe been used outside of mapData? Add to assumptions if
      // this stays.
      if (!this.insideMapData) {
        throw new Error('dream: observe can only be used within mapData with this estimator.');
      }
      if (!this.obsArr && this.obs.length !== 0) {
        throw new Error('dream: Expected to see only a single observe per data point.');
      }

      var val = dist.sample();
      this.record.trace.addChoice(dist, val, a, s, k);
      // TODO: Update targetScore? (Also see sample.)
      this.obs.push(val);
      return k(s, val);
    },

    mapDataEnter: function() {
      this.obs = [];
    },

    mapDataLeave: function() {
      var datum = this.obsArr ? this.obs : this.obs[0];
      this.record.data.push(datum);
    },

    mapDataFetch: function(data, batchSize, a) {
      if (this.insideMapData) {
        throw new Error('dream: nested mapData is not supported by this estimator.');
      }
      this.insideMapData = true;

      // Flag indicating whether each element of the original data is
      // an array of observations or a single observation. (We check
      // the first datum, and assume the rest of data would return the
      // same.)

      this.obsArr = data.length > 0 && _.isArray(data[0]);

      // TODO: Sub-sample a desired number of data points?
      // TODO: Return dummy data? nulls/arrays of nulls perhaps?
      return null; // Indicate that all of data should be mapped over.
    },

    mapDataFinal: function() {
      this.insideMapData = false;
    }

  };

  function sampleFantasy() {
    var coroutine = Object.create(sampleFantasyCoroutine.prototype);
    sampleFantasyCoroutine.apply(coroutine, arguments);
    return coroutine.run();
  }

  // --------------------------------------------------
  // Coroutine to estimate gradients.
  // --------------------------------------------------



  // --------------------------------------------------
  // Estimator for use with Optimize.
  // --------------------------------------------------
  return function(wpplFn, s, a, options, state, step, cont) {
    var opts = util.mergeDefaults(options, {
      samples: 1
    });

    var objectiveVal = 0;
    var grad = {};

    return util.cpsLoop(
      opts.samples,
      // Loop body.
      function(i, next) {

        return sampleFantasy(wpplFn, s, a, function(record) {

          console.log(record);
          return next();

          //return estimateGradient(function(g, objectiveVal_i) {
            //paramStruct.addEq(grad, g);
            //objectiveVal += objectiveVal_i;
            //return next();
          //});

        });

      },
      // Continuation.
      function() {
        // TODO: divide by num samples.
        return cont(grad, objectiveVal);

      });
  };

};
