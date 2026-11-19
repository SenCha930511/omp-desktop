use crate::error::{CoreError, Result};

pub fn parse_http_url(value: &str, label: &str) -> Result<url::Url> {
    let parsed = url::Url::parse(value)
        .map_err(|_| CoreError::invalid(format!("{label} must be a valid URL")))?;
    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        return Err(CoreError::invalid(format!(
            "{label} must use http or https"
        )));
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err(CoreError::invalid(format!(
            "{label} must not contain credentials"
        )));
    }
    if parsed.host_str().is_none() {
        return Err(CoreError::invalid(format!("{label} must include a host")));
    }
    Ok(parsed)
}

pub fn is_loopback_or_private(host: &str) -> bool {
    let host = host.trim_matches(['[', ']']);
    if host == "localhost" || host == "127.0.0.1" || host == "::1" {
        return true;
    }
    if let Ok(address) = host.parse::<std::net::IpAddr>() {
        return match address {
            std::net::IpAddr::V4(address) => {
                address.is_loopback() || address.is_private() || address.is_link_local()
            }
            std::net::IpAddr::V6(address) => address.is_loopback(),
        };
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_lookalike_loopback_hosts() {
        assert!(!is_loopback_or_private("127.0.0.1.evil.example"));
        assert!(!is_loopback_or_private("localhost.evil.example"));
        assert!(is_loopback_or_private("127.0.0.1"));
        assert!(is_loopback_or_private("192.168.1.2"));
        assert!(is_loopback_or_private("10.0.0.5"));
    }

    #[test]
    fn rejects_credentials_and_non_http_schemes() {
        assert!(parse_http_url("https://user:pass@example.com", "url").is_err());
        assert!(parse_http_url("file:///etc/passwd", "url").is_err());
        assert!(parse_http_url("https://example.com", "url").is_ok());
    }
}
