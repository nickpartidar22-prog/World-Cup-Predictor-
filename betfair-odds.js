[build]
  publish = "."

[functions]
  directory = "netlify/functions"
  node_bundler = "esbuild"

[[redirects]]
  from = "/api/*"
  to   = "/.netlify/functions/:splat"
  status = 200

[[headers]]
  for = "/js/*"
  [headers.values]
    Cache-Control = "public, max-age=300"
    Content-Type  = "application/javascript; charset=utf-8"

[[headers]]
  for = "/css/*"
  [headers.values]
    Cache-Control = "public, max-age=300"

[[headers]]
  for = "/sw.js"
  [headers.values]
    Cache-Control = "no-cache"
