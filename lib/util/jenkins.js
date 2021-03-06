/*
 *  Copyright 2012 Rackspace
 *
 *  Licensed under the Apache License, Version 2.0 (the "License");
 *  you may not use this file except in compliance with the License.
 *  You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 *  Unless required by applicable law or agreed to in writing, software
 *  distributed under the License is distributed on an "AS IS" BASIS,
 *  WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 *  See the License for the specific language governing permissions and
 *  limitations under the License.
 *
 */

var url = require('url');
var util = require('util');
var request = require('request');
var logmagic = require('logmagic');
var async = require('async');

var TREE_FILTER = 'depth=1&tree=builds[actions[lastBuiltRevision[SHA1]],' +
    'result,building,timestamp,url,fullDisplayName,number]';

/**
 * Jenkins Client.
 * @constructor
 * @param {Object} options, including:
 *      url: Jenkins server URL
 *      username, password: Credentials
 *      delay: polling interval in milliseconds
 *      attempts: number of polling attempts to wait for builds to appear
 * @param {Object} log Optional logging util
 */
function Jenkins(options, log) {
  var parsed = url.parse(options.url);

  if (options.username && options.password) {
    parsed['auth'] = util.format('%s:%s', options.username, options.password);
  }

  this._url = url.format(parsed);
  this._options = options;
  this.log = log || logmagic.local('jenkins');
}

/**
 * Ensure that a revision is built on Jenkins by polling until its completion.
 *
 * @param {String} builder The Jenkins project to build
 * @param {?String} branch The branch to build. Defaults to master.
 * @param {String} revision The full SHA1 of the revision to build
 * @param {Function} callback The completion callback(err, build)
 */
Jenkins.prototype.ensureRevisionBuilt = function(builder, branch, revision, callback) {
  var self = this;
  var build = null;
  var polling = false;
  var forceBuild = self._options.force_build;
  var attempts = 0;

  self.log.infof('Attempting to deploy revision ${rev}...', {rev: revision});

  function getLastBuild(callback) {
    self.getRevision(builder, revision, function(err, last_build) {
      if (err) {
        return callback(err, null);
      }

      if (!build || build.building === false) {
        attempts++;
      }

      build = last_build;
      callback(null, build);
    });
  }

  function pollJenkins(asyncCallback) {
    var errorMsg;

    if (!polling && forceBuild) {  // Wait a few seconds before the first poll
      polling = true;
      setTimeout(asyncCallback, self._options.delay);
      return;
    }

    if (attempts >= self._options.attempts) {
      errorMsg = util.format('ERROR: Jenkins did not report a build after checking %s times',
                             attempts);
      return asyncCallback(new Error(errorMsg), null);
    }

    setTimeout(getLastBuild, self._options.delay, asyncCallback);
  }

  function isBuilt() {
    if (self.isBuildComplete(build)) {
      return true;
    }

    if (polling === false && forceBuild) {   // Kick the build, this is the first poll
      if (!build || build.building === false) {
        self.build(builder, branch, revision, function(err, resp, body) {
          if (err) {
            return callback(err, null);
          }
        });
      }
    }
    return false;
  }

  getLastBuild(function(err, retrievedBuild) {
    if (err) {
      callback(err);
    } else if (retrievedBuild && self.isBuildComplete(build)) {
      callback(null, retrievedBuild);
    } else {
      async.until(isBuilt, pollJenkins, function(err) { callback(err, build); });
    }
  });
};

/**
 * Determines whether a build object with attributes .building and .result
 * is complete.
 *
 * @param build {Object=} Build object, or null
 * @return True if the build is complete, False otherwise
 */
Jenkins.prototype.isBuildComplete = function(build) {
  if (!build) {
    this.log.info('Jenkins does not yet show a build for this revision');
    return false;
  } else if (build.building === true) {
    this.log.infof('"${name}" is building', {
      name: build.fullDisplayName,
      startedAt: new Date(build.timestamp).toISOString(),
      url: build.url
    });
    return false;
  } else {
    if (this.isBuildSuccessful(build)) {
      this.log.info('Build succeeded!', build);
    } else {
      this.log.infof('Build finished, but status was ${status}', {
        status: build.result
      });
    }
    return true;
  }
};

/**
 * Determines whether a given build ended with a 'SUCCESS' status
 *
 * @param build {Object} Build object with a .result attribute
 * @return True if the build was successful
 */
Jenkins.prototype.isBuildSuccessful = function(build) {
  return (build.result === 'SUCCESS');
};

/**
 * Begin a build of the given revision on Jenkins.
 *
 * @param builder {String} Jenkins project to build
 * @param {?String} branch The branch to build. Defaults to master.
 * @param revision {String} Full SHA1 to build
 * @param callback {Function} callback(err, http.ClientResponse, body) to be
 *     run when the response is received.
 */
Jenkins.prototype.build = function(builder, branch, revision, callback) {
  var options = {
    url: util.format('%s/job/%s/buildWithParameters', this._url, builder),
    qs : {'REV': revision}
  };

  this.log.infof('Forcing build of revision ${rev} on ${builder}', {
    rev: revision,
    options: options,
    builder: builder
  });
  request.get(options, callback);
};

/**
 * Use the Jenkins API to find the most recent build with the given revision.
 *
 * @param builder {String} Jenkins project to use when looking for build
 * @param revision {String} SHA1 of build to look for
 * @param callback {Function} callback(err, build) to run when build is found.
 *     build is null if there was no such build.
 */
Jenkins.prototype.getRevision = function(builder, revision, callback) {
  var url = util.format('%s/job/%s/api/json?%s', this._url, builder, TREE_FILTER),
      self = this;

  request.get(url, function(err, response, body) {
    var i, build, buildSha, buildREV;

    if (err) {
      return callback(err);
    }

    try {
      body = JSON.parse(body);
    } catch (e) {
      return callback(e);
    }

    for (i = 0; i < body.builds.length; i++) {
      build = body.builds[i];
      buildSha = self._getBuildSHA(build);
      buildREV = self._getBuildREV(build);
      if (revision === buildSha || revision === buildREV) {
        return callback(null, build);
      }
    }
    callback();
  });
};

/**
 * Convenience method to find the SHA1 of a Jenkins build
 * (it's buried in the object).
 *
 * @param build {Object} Jenkins build
 * @return {String} SHA1 of the build
 */
Jenkins.prototype._getBuildSHA = function (build) {
  var actions = build.actions,
      action, i;

  for (i=0; i < build.actions.length; i++) {
    action = actions[i];
    if (action && action.hasOwnProperty('lastBuiltRevision')) {
      return action.lastBuiltRevision.SHA1;
    }
  }
};

/**
  * Method to get the REV parameter that was passed, since
  * this can be something other than a SHA1 revision hash,
  * i.e. a tag or branch name.
  **/
Jenkins.prototype._getBuildREV = function (build) {
  var actions = build.actions,
      action, i;

  for (i=0; i < build.actions.length; i++) {
    action = actions[i];
    if (action.hasOwnProperty('parameters')) {
      for (var j=0; j < action.parameters.length; j++) {
        var parameter = action.parameters[j];
        if (parameter.hasOwnProperty('name')) {
          if (parameter.name === "REV") {
            return parameter.value;
          }
        }
      }
    }
  }
};

Jenkins.prototype._getUpstreamNumber = function (build) {
  var j, k;
  if (build.hasOwnProperty('actions')) {
    for (j = 0; j < build.actions.length; j++) {
      var action = build.actions[j];
      if (action.hasOwnProperty('causes')) {
        for (k = 0; k < action.causes.length; k++) {
          var cause = action.causes[k];
          if (cause.hasOwnProperty('upstreamBuild')) {
            return cause.upstreamBuild;
          }
        }
      }
    }
  }
};


Jenkins.prototype.getBuildByUpstreamBuild = function(builder, build, callback) {
  var qs = 'depth=1&tree=builds[actions[causes[upstreamBuild]],' +
           'result,building,timestamp,url,fullDisplayName,number]';

  var url = util.format('%s/job/%s/api/json?%s', this._url, builder, qs),
      self = this;

  request.get(url, function(err, response, body) {
    self.log.infof('Got builds from Jenkins, looking for build ${build_num}...', {
      build_num: build.number
    });

    if (err) {
      return callback(err);
    }

    try {
      body = JSON.parse(body);
    } catch (e) {
      return callback(e);
    }

    var i, b;
    for (i = 0; i < body.builds.length; i++) {
      b = body.builds[i];
      var upstream_build = self._getUpstreamNumber(b);
      if (upstream_build === build.number) {
        return callback(null, b);
      }
    }
    callback();
  });
};

/**
 * Method to check the status of a downstream build.
 *
 * @param upstream_build {Object} Jenkins build
 * @param dsProjectName {String} Name of the downstream project
 * @param callback {function} callback to execute on completion
 * @return
 */
Jenkins.prototype.ensureDownstreamBuilt = function(upstream_build, dsProjectName, callback) {
  var qs = "depth=1&tree=builds[actions[causes[upstreamBuild]]]";
  var url = util.format('%s/job/%s/api/json?%s', this._url, dsProjectName, qs),
      self = this;


  var polling = false;
  var attempts = 0;
  var build = null;

  function getLastBuild(callback) {
    self.getBuildByUpstreamBuild(dsProjectName, upstream_build, function(err, last_build) {
      if (err) {
        return callback(err, null);
      }

      if (!build || build.building === false) {
        attempts++;
      }

      build = last_build;
      callback(null, build);
    });
  }

  function pollJenkins(asyncCallback) {
    var errorMsg;

    if (!polling) {  // Wait a few seconds before the first poll
      polling = true;
      setTimeout(asyncCallback, self._options.delay);
      return;
    }

    if (attempts > self._options.attempts) {
      errorMsg = util.format('ERROR: Jenkins did not report a build after checking %s times',
                             attempts);
      return asyncCallback(new Error(errorMsg), null);
    }

    setTimeout(getLastBuild, self._options.delay, asyncCallback);
  }

  function isBuilt() {
    return self.isBuildComplete(build) ? true : false;
  }

  getLastBuild(function(err, retrievedBuild) {
    if (err) {
      callback(err);
    } else if (retrievedBuild && self.isBuildComplete(build)) {
      callback(null, retrievedBuild);
    } else {
      async.until(isBuilt, pollJenkins, function(err) { callback(err, build); });
    }
  });
};

exports.Jenkins = Jenkins;
