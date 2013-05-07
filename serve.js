var sys = require("sys"),
    http = require("http"),
    https = require("https"),
    fs = require("fs"),
    qs = require("querystring"),
    url_parse = require("url").parse,
    ujs = require("uglify-js2"),
    Mold = require("mold-template");
ujs.AST_Node.warn_function = null;

var ujsversion = JSON.parse(fs.readFileSync("./node_modules/uglify-js2/package.json", "utf8")).version;

function forEachIn(obj, f) {
  var hop = Object.prototype.hasOwnProperty;
  for (var n in obj) if (hop.call(obj, n)) f(n, obj[n]);
}

function parseQuery(query) {
  var parsed = qs.parse(query);
  forEachIn(parsed, function(prop, val) {
    if (!Array.isArray(val)) parsed[prop] = [val];
  });
  return parsed;
}
function queryVal(query, name) {
  return query.hasOwnProperty(name) ? query[name][0] : null;
}

var templates = {};
function template(name) {
  if (templates.hasOwnProperty(name)) return templates[name];
  return templates[name] = Mold.bake(fs.readFileSync("templates/" + name, "utf8"));
}

function uglify(files, ascii_only, source_map) {
  var parsed = null, allNamed = true, opts = {ascii_only: ascii_only};
  files.forEach(function(file) {
    parsed = ujs.parse(file.string, {filename: file.name, toplevel: parsed});
    if (!file.name) allNamed = false;
  });
  if (!parsed) return "";
  if (source_map) {
    if (!allNamed) throw new Error("Source maps only work when all files are URLs");
    opts.source_map = ujs.SourceMap({});
  }
  var compressor = ujs.Compressor({});
  parsed.figure_out_scope();
  parsed.transform(compressor);
  parsed.mangle_names();
  var output = ujs.OutputStream(opts);
  parsed.print(output);
  return source_map ? opts.source_map.toString() : output.get();
}

function readData(obj, c) {
  var received = [];
  obj.setEncoding("utf8");
  obj.addListener("data", function(chunk) {received.push(chunk);});
  obj.addListener("end", function() {c(received.join(""));});
}

http.createServer(function(req, resp) {
  var question = req.url.indexOf("?");
  var query = question == -1 ? {} : parseQuery(req.url.slice(question + 1));
  if (req.method == "POST" && req.headers["content-type"] == "application/x-www-form-urlencoded") {
    readData(req, function(data) {
      forEachIn(parseQuery(data), function(name, val) {
        var current = query.hasOwnProperty(name) && query[name];
        query[name] = current ? current.concat(val) : val;
      });
      respond(query, resp);
    });
  } else {
    respond(query, resp);
  }
}).listen(8080, "localhost");

function gatherCode(direct, urls, c) {
  var files = [], todo = urls.length + 1;
  function done() {
    if (--todo == 0) {
      if (direct) files.push({string: direct});
      c(files.filter(function(x){return x;}));
    }
  }
  function handle(url, i, redir) {
    var chunks = [];
    var req = (/^https:/.test(url) ? https : http).request(url_parse(url), function(resp) {
      if (resp.statusCode < 300) {
        resp.on("data", function(chunk) {chunks.push(chunk);});
        resp.on("end", function() {
          files[i] = {string: chunks.join(""), name: url};
          done();
        });
        resp.on("error", done);
      } else if (resp.statusCode < 400 && redir < 10 && resp.headers.location) {
        handle(resp.headers.location, i, redir + 1);
      } else done();
    });
    req.on("error", function(e) { console.log(e); done(); });
    req.end();
  }
  urls.forEach(function(url, i) {
    if (/^https?:/.test(url)) handle(url, i, 0);
    else done();
  });
  done();
}

function respond(query, resp) {
  var direct = queryVal(query, "js_code"), urls = query.code_url || [],
      ascii_only = typeof queryVal(query, "utf8") != "string",
      source_map = typeof queryVal(query, "source_map") == "string";
  gatherCode(direct, urls, function(files) {
    try { var output = uglify(files, ascii_only, source_map); }
    catch(e) { var error = e.message || e.msg; }
    if (queryVal(query, "form") == "show" || !files.length) {
      var totalLen = files.reduce(function(cur, f) {return cur + f.string.length;}, 0);
      respondHTML(direct, urls, totalLen, ascii_only, output, error, resp);
    } else {
      respondDirect(queryVal(query, "download"), output, error, resp);
    }
  });
}

function respondHTML(direct, urls, totalLen, ascii, output, error, resp) {
  resp.writeHead(200, {"Content-Type": "text/html"});
  resp.write(template("body")({
    code: direct,
    urls: urls, old_size: totalLen, ascii_only: ascii,
    mini: output, error: error,
    version: ujsversion
  }));
  resp.end();
}

function respondDirect(download, output, error, resp) {
  if (error) {
    resp.writeHead(400, {"Content-Type": "text/html"});
    resp.write(template("failed")(error));
  } else {
    var headers = {"Content-Type": "text/javascript"};
    if (download) headers["Content-Disposition"] = "attachment; filename=" + download;
    resp.writeHead(200, headers);
    resp.write(output);
  }
  resp.end();
}
