# Servidor estático mínimo para probar la app en http://localhost:8080 (sin Node ni Python).
# Uso: powershell -ExecutionPolicy Bypass -File scripts\servir-local.ps1 [-Port 8080]
param([int]$Port = 8080)

$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$mime = @{
  '.html' = 'text/html; charset=utf-8'; '.js' = 'text/javascript; charset=utf-8'; '.mjs' = 'text/javascript; charset=utf-8'
  '.css' = 'text/css; charset=utf-8'; '.json' = 'application/json'; '.webmanifest' = 'application/manifest+json'
  '.png' = 'image/png'; '.jpg' = 'image/jpeg'; '.svg' = 'image/svg+xml'; '.ico' = 'image/x-icon'
  '.wasm' = 'application/wasm'; '.gz' = 'application/gzip'; '.txt' = 'text/plain; charset=utf-8'
}

$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://localhost:$Port/")
$listener.Start()
Write-Host "Sirviendo $root en http://localhost:$Port/  (Ctrl+C para detener)"

try {
  while ($listener.IsListening) {
    $ctx = $listener.GetContext()
    $res = $ctx.Response
    try {
      $rel = [Uri]::UnescapeDataString($ctx.Request.Url.AbsolutePath).TrimStart('/')
      if ($rel -eq '' -or $rel.EndsWith('/')) { $rel += 'index.html' }
      $path = [IO.Path]::GetFullPath((Join-Path $root $rel))
      if (-not $path.StartsWith($root) -or -not (Test-Path $path -PathType Leaf)) {
        $res.StatusCode = 404
        $bytes = [Text.Encoding]::UTF8.GetBytes('404')
      } else {
        $ext = [IO.Path]::GetExtension($path).ToLower()
        $res.ContentType = if ($mime.ContainsKey($ext)) { $mime[$ext] } else { 'application/octet-stream' }
        $res.Headers.Add('Cache-Control', 'no-cache')
        $bytes = [IO.File]::ReadAllBytes($path)
      }
      $res.ContentLength64 = $bytes.Length
      if ($ctx.Request.HttpMethod -ne 'HEAD') { $res.OutputStream.Write($bytes, 0, $bytes.Length) }
      Write-Host "$($res.StatusCode) /$rel"
    } catch {
      Write-Host "500 $($ctx.Request.Url.AbsolutePath): $($_.Exception.Message)"
      try { $res.StatusCode = 500 } catch {}
    } finally {
      $res.Close()
    }
  }
} finally {
  $listener.Stop()
}
