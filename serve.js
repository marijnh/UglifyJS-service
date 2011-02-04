var sys = require("sys"),
    http = require("http"),
    fs = require("fs"),
    qs = require("querystring"),
    url = require("url"),
    jsp = require("./lib/UglifyJS/lib/parse-js"),
    pro = require("./lib/UglifyJS/lib/process"),
    Mold = require("./lib/mold/mold.node");

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

function uglify(code) {
  return pro.gen_code(pro.ast_squeeze(pro.ast_mangle(jsp.parse(code))));
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
  var accum = [];
  // TODO more parallel
  function iter(i) {
    if (i == urls.length) {
      accum.push(direct);
      c(accum.join("\n"));
    }
    else {
      var parsed = url.parse(urls[i]);
      if (/^https?:$/.test(parsed.protocol)) {
        var client = http.createClient(parsed.port || 80, parsed.hostname, parsed.protocol == "https:");
        var req = client.request("GET", parsed.pathname + (parsed.search || ""), {"Host": parsed.hostname});
        var chunks = [];
        req.on("response", function(resp) {
          if (resp.statusCode < 300) {
            resp.on("data", function(chunk) {chunks.push(chunk);});
            resp.on("end", function() {accum.push(chunks.join("")); iter(i + 1);});
          }
          else iter(i + 1);
        });
        req.end();
      }
      else iter(i + 1);
    }
  }
  iter(0);
}

function respond(query, resp) {
  var direct = queryVal(query, "js_code"), urls = query.code_url || [];
  gatherCode(direct, urls, function(code) {
    if (queryVal(query, "form") == "show" || !code)
      respondHTML(direct, urls, code, resp);
    else
      respondDirect(code, queryVal(query, "download"), resp);
  });
}

function respondHTML(direct, urls, code, resp) {
  resp.writeHead(200, {"Content-Type": "text/html"});
  var tmpl = {code: direct, urls: urls, old_size: code.length};
  if (code) {
    try {tmpl.mini = uglify(code);}
    catch(e) {tmpl.error = e.message;}
  }
  resp.write(template("body")(tmpl));
  resp.end();
}

function respondDirect(code, download, resp) {
  var mini, error;
  try {mini = uglify(code);}
  catch(e) {error = e.message;}
  if (error) {
    resp.writeHead(400, {"Content-Type": "text/html"});
    resp.write(template("failed")(error));
  }
  else {
    var headers = {"Content-Type": "text/javascript"};
    if (download) headers["Content-Disposition"] = "attachment; filename=" + download;
    resp.writeHead(200, headers);
    resp.write(mini);
  }
  resp.end();
}
