var sys = require("sys"),
    http = require("http"),
    fs = require("fs"),
    qs = require("querystring"),
    url = require("url"),
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
  if (req.method == "POST" && req.headers["content-type"] == "application/x-www-form-urlencoded")
    readData(req, function(data) {
      forEachIn(parseQuery(data), function(name, val) {
        var current = query.hasOwnProperty(name) && query[name];
        query[name] = current ? current.concat(val) : val;
      });
      respond(query, resp);
    });
  else
    respond(query, resp);
}).listen(8080, "localhost");

function gatherCode(direct, urls, c) {
  var files = [];
  // TODO more parallel
  function iter(i) {
    if (i == urls.length) {
      if (direct) files.push({string: direct});
      c(files);
    }
    else {
      var parsed = url.parse(urls[i]);
      if (/^https?:$/.test(parsed.protocol)) {
        var client = http.createClient(parsed.port || 80, parsed.hostname, parsed.protocol == "https:");
        var req = client.request("GET", parsed.pathname + (parsed.search || ""), {"Host": parsed.hostname});
        var chunks = [], redir = 0;
        req.on("response", function(resp) {
          if (resp.statusCode < 300) {
            resp.on("data", function(chunk) {chunks.push(chunk);});
            resp.on("end", function() {
              files.push({string: chunks.join(""), name: urls[i]});
              iter(i + 1);
            });
            resp.on("error", function(e) { iter(i + 1); });
          } else if (resp.statusCode < 400 && redir < 10 && resp.headers.location) {
            redir++;
            urls[i] = resp.headers.location;
            iter(i);
          } else iter(i + 1);
        });
        req.on("error", function(e) { console.log(e);iter(i + 1); });
        req.end();
      }
      else iter(i + 1);
    }
  }
  iter(0);
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
