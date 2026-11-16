//! Local loopback HTTP static file streamer with HTTP Range support & TCP_NODELAY.
//! Enables instant 60fps native WebView2 PDF viewing and relative SVG/PNG resolution in Markdown & HTML.

use std::fs::File;
use std::io::{BufRead, BufReader, BufWriter, Read, Seek, SeekFrom, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::{Arc, RwLock};

#[derive(Clone)]
pub struct AssetServer {
    port: u16,
    token: String,
    allowed_roots: Arc<RwLock<Vec<PathBuf>>>,
}

impl AssetServer {
    pub fn start() -> Result<Self, String> {
        let listener = TcpListener::bind("127.0.0.1:0")
            .map_err(|e| format!("无法启动本地文档流服务: {e}"))?;
        let port = listener
            .local_addr()
            .map_err(|e| format!("无法获取本地服务端口: {e}"))?
            .port();
        let token = uuid::Uuid::new_v4().simple().to_string();
        let allowed_roots = Arc::new(RwLock::new(Vec::new()));

        let token_clone = token.clone();
        let roots_clone = Arc::clone(&allowed_roots);

        std::thread::Builder::new()
            .name("docprism-asset-server".into())
            .spawn(move || {
                for stream in listener.incoming().flatten() {
                    let t = token_clone.clone();
                    let r = Arc::clone(&roots_clone);
                    std::thread::spawn(move || {
                        let _ = handle_connection(stream, &t, &r);
                    });
                }
            })
            .map_err(|e| format!("无法创建文档流后台线程: {e}"))?;

        Ok(Self {
            port,
            token,
            allowed_roots,
        })
    }

    pub fn base_url(&self) -> String {
        format!("http://127.0.0.1:{}/fs/{}", self.port, self.token)
    }

    pub fn authorize_dir(&self, dir: &Path) {
        if let Ok(canon) = std::fs::canonicalize(dir) {
            if let Ok(mut guard) = self.allowed_roots.write() {
                if !guard.iter().any(|existing| existing == &canon) {
                    guard.push(canon);
                }
            }
        }
    }

    pub fn authorize_file_context(&self, file_path: &Path) {
        if let Some(parent) = file_path.parent() {
            self.authorize_dir(parent);
            if let Some(grandparent) = parent.parent() {
                self.authorize_dir(grandparent);
            }
        }
    }
}

fn handle_connection(
    stream: TcpStream,
    expected_token: &str,
    allowed_roots: &RwLock<Vec<PathBuf>>,
) -> std::io::Result<()> {
    // Critical on Windows loopback: avoid Nagle + Delayed ACK 40~200ms stalls!
    let _ = stream.set_nodelay(true);
    let _ = stream.set_read_timeout(Some(std::time::Duration::from_secs(3)));
    let _ = stream.set_write_timeout(Some(std::time::Duration::from_secs(15)));

    let mut reader = BufReader::with_capacity(8192, stream.try_clone()?);
    let mut writer = BufWriter::with_capacity(65536, stream);

    let mut request_line = String::new();
    if reader.read_line(&mut request_line)? == 0 {
        return Ok(());
    }
    let parts: Vec<&str> = request_line.split_whitespace().collect();
    if parts.len() < 2 {
        return send_status(&mut writer, "400 Bad Request", "Bad Request");
    }
    let method = parts[0];
    let raw_target = parts[1];

    if method == "OPTIONS" {
        let resp = "HTTP/1.1 204 No Content\r\nAccess-Control-Allow-Origin: *\r\nAccess-Control-Allow-Methods: GET, HEAD, OPTIONS\r\nAccess-Control-Allow-Headers: Range\r\nConnection: close\r\n\r\n";
        writer.write_all(resp.as_bytes())?;
        return writer.flush();
    }
    if method != "GET" && method != "HEAD" {
        return send_status(&mut writer, "405 Method Not Allowed", "Method Not Allowed");
    }

    let mut range_header: Option<String> = None;
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line)? == 0 || line == "\r\n" || line == "\n" {
            break;
        }
        if let Some((k, v)) = line.split_once(':') {
            if k.trim().eq_ignore_ascii_case("range") {
                range_header = Some(v.trim().to_string());
            }
        }
    }

    let path_part = raw_target.split('?').next().unwrap_or(raw_target);
    let prefix = format!("/fs/{}/", expected_token);
    let Some(encoded_rel) = path_part.strip_prefix(&prefix) else {
        return send_status(&mut writer, "403 Forbidden", "Invalid session token");
    };

    let decoded = percent_decode(encoded_rel);
    let normalized = decoded.trim_start_matches('/').replace('/', r"\");
    let candidate = PathBuf::from(&normalized);

    let Ok(canon_file) = std::fs::canonicalize(&candidate) else {
        return send_status(&mut writer, "404 Not Found", "File not found");
    };

    let is_allowed = allowed_roots
        .read()
        .map(|roots| roots.iter().any(|root| canon_file.starts_with(root)))
        .unwrap_or(false);

    if !is_allowed || !canon_file.is_file() {
        return send_status(&mut writer, "403 Forbidden", "Access denied");
    }

    let mut file = File::open(&canon_file)?;
    let total_len = file.metadata()?.len();
    let mime = guess_mime_type(&canon_file);

    if let Some(range_str) = range_header {
        if let Some((start, end)) = parse_byte_range(&range_str, total_len) {
            let chunk_len = end - start + 1;
            let header = format!(
                "HTTP/1.1 206 Partial Content\r\n\
                 Content-Type: {mime}\r\n\
                 Content-Length: {chunk_len}\r\n\
                 Content-Range: bytes {start}-{end}/{total_len}\r\n\
                 Accept-Ranges: bytes\r\n\
                 Access-Control-Allow-Origin: *\r\n\
                 Cache-Control: private, max-age=30\r\n\
                 Connection: close\r\n\r\n"
            );
            writer.write_all(header.as_bytes())?;
            if method == "GET" {
                file.seek(SeekFrom::Start(start))?;
                copy_exact_bytes(&mut file, &mut writer, chunk_len)?;
            }
            return writer.flush();
        }
    }

    let header = format!(
        "HTTP/1.1 200 OK\r\n\
         Content-Type: {mime}\r\n\
         Content-Length: {total_len}\r\n\
         Accept-Ranges: bytes\r\n\
         Access-Control-Allow-Origin: *\r\n\
         Content-Disposition: inline\r\n\
         Cache-Control: private, max-age=30\r\n\
         Connection: close\r\n\r\n"
    );
    writer.write_all(header.as_bytes())?;
    if method == "GET" {
        copy_exact_bytes(&mut file, &mut writer, total_len)?;
    }
    writer.flush()
}

fn copy_exact_bytes<W: Write>(
    file: &mut File,
    writer: &mut W,
    mut remaining: u64,
) -> std::io::Result<()> {
    let mut buf = [0u8; 65536];
    while remaining > 0 {
        let to_read = (remaining as usize).min(buf.len());
        let n = file.read(&mut buf[..to_read])?;
        if n == 0 {
            break;
        }
        writer.write_all(&buf[..n])?;
        remaining -= n as u64;
    }
    Ok(())
}

fn send_status<W: Write>(writer: &mut W, code: &str, body: &str) -> std::io::Result<()> {
    let resp = format!(
        "HTTP/1.1 {code}\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: {}\r\nAccess-Control-Allow-Origin: *\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    writer.write_all(resp.as_bytes())?;
    writer.flush()
}

pub fn percent_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let (Some(hi), Some(lo)) = (hex_val(bytes[i + 1]), hex_val(bytes[i + 2])) {
                out.push((hi << 4) | lo);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn hex_val(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

pub fn parse_byte_range(header: &str, total_len: u64) -> Option<(u64, u64)> {
    if total_len == 0 {
        return None;
    }
    let spec = header.strip_prefix("bytes=")?;
    let first_range = spec.split(',').next()?.trim();
    let (start_s, end_s) = first_range.split_once('-')?;

    if start_s.is_empty() {
        let suffix: u64 = end_s.parse().ok()?;
        if suffix == 0 {
            return None;
        }
        let start = total_len.saturating_sub(suffix);
        Some((start, total_len - 1))
    } else {
        let start: u64 = start_s.parse().ok()?;
        if start >= total_len {
            return None;
        }
        let end = if end_s.is_empty() {
            total_len - 1
        } else {
            end_s.parse::<u64>().ok()?.min(total_len - 1)
        };
        if start <= end {
            Some((start, end))
        } else {
            None
        }
    }
}

fn guess_mime_type(path: &Path) -> &'static str {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    match ext.as_str() {
        "pdf" => "application/pdf",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "ico" => "image/x-icon",
        "html" | "htm" => "text/html; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "js" | "mjs" => "application/javascript; charset=utf-8",
        "md" | "markdown" | "txt" => "text/plain; charset=utf-8",
        "json" => "application/json; charset=utf-8",
        "woff2" => "font/woff2",
        "woff" => "font/woff",
        "ttf" => "font/ttf",
        _ => "application/octet-stream",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_chinese_and_spaces_correctly() {
        let encoded =
            "D:/huangjunjie/fine-tune%20the%20model/gemini/%E7%A5%9E%E7%BB%8F%E7%AE%97%E5%AD%90/01.md";
        assert_eq!(
            percent_decode(encoded),
            "D:/huangjunjie/fine-tune the model/gemini/神经算子/01.md"
        );
    }

    #[test]
    fn parses_http_byte_ranges() {
        assert_eq!(parse_byte_range("bytes=0-499", 1000), Some((0, 499)));
        assert_eq!(parse_byte_range("bytes=500-", 1000), Some((500, 999)));
        assert_eq!(parse_byte_range("bytes=-200", 1000), Some((800, 999)));
        assert_eq!(parse_byte_range("bytes=1200-1300", 1000), None);
    }
}
