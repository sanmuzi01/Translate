//! API Key 的加密存储。
//! Windows 下用系统自带的 DPAPI(CryptProtectData):密文只能由"同一个 Windows 用户"在"同一台电脑"上解开,
//! 配置文件被拷走、被别的用户读到,都拿不到明文 Key。不需要自己管理密钥。
//! 存储格式:"dpapi:" + 十六进制密文。没有这个前缀的按旧版明文处理(下次保存时自动升级成加密)。

const PREFIX: &str = "dpapi:";

fn to_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn from_hex(s: &str) -> Option<Vec<u8>> {
    if s.len() % 2 != 0 {
        return None;
    }
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(s.get(i..i + 2)?, 16).ok())
        .collect()
}

/// 明文 -> 可以写进配置文件的字符串。空串原样返回;加密失败时退回明文(宁可能用,也别丢 Key)。
pub fn seal(plain: &str) -> String {
    if plain.is_empty() {
        return String::new();
    }
    #[cfg(windows)]
    if let Some(cipher) = dpapi::protect(plain.as_bytes()) {
        return format!("{PREFIX}{}", to_hex(&cipher));
    }
    plain.to_string()
}

/// 配置文件里的字符串 -> 明文。解不开(换了电脑/用户)返回空串,让用户重新填写。
pub fn open(stored: &str) -> String {
    let Some(hex) = stored.strip_prefix(PREFIX) else {
        return stored.to_string(); // 旧版明文
    };
    #[cfg(windows)]
    if let Some(plain) = from_hex(hex).and_then(|c| dpapi::unprotect(&c)) {
        return String::from_utf8(plain).unwrap_or_default();
    }
    #[cfg(not(windows))]
    let _ = hex;
    String::new()
}

#[cfg(windows)]
mod dpapi {
    use windows::Win32::Foundation::{LocalFree, HLOCAL};
    use windows::Win32::Security::Cryptography::{
        CryptProtectData, CryptUnprotectData, CRYPT_INTEGER_BLOB,
    };

    fn blob(data: &[u8]) -> CRYPT_INTEGER_BLOB {
        CRYPT_INTEGER_BLOB { cbData: data.len() as u32, pbData: data.as_ptr() as *mut u8 }
    }

    /// 取出系统分配的输出缓冲区里的内容并释放它
    unsafe fn take(out: CRYPT_INTEGER_BLOB) -> Vec<u8> {
        let v = std::slice::from_raw_parts(out.pbData, out.cbData as usize).to_vec();
        let _ = LocalFree(Some(HLOCAL(out.pbData as *mut _)));
        v
    }

    pub fn protect(plain: &[u8]) -> Option<Vec<u8>> {
        unsafe {
            let input = blob(plain);
            let mut out = CRYPT_INTEGER_BLOB::default();
            CryptProtectData(&input, None, None, None, None, 0, &mut out).ok()?;
            Some(take(out))
        }
    }

    pub fn unprotect(cipher: &[u8]) -> Option<Vec<u8>> {
        unsafe {
            let input = blob(cipher);
            let mut out = CRYPT_INTEGER_BLOB::default();
            CryptUnprotectData(&input, None, None, None, None, 0, &mut out).ok()?;
            Some(take(out))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hex_roundtrip() {
        assert_eq!(from_hex(&to_hex(&[0, 1, 254, 255])), Some(vec![0, 1, 254, 255]));
        assert_eq!(from_hex("abc"), None);
        assert_eq!(from_hex("zz"), None);
    }

    #[test]
    fn legacy_plaintext_is_still_readable() {
        assert_eq!(open("sk-legacy"), "sk-legacy");
        assert_eq!(open(""), "");
    }

    #[cfg(windows)]
    #[test]
    fn sealed_key_is_not_plaintext_and_roundtrips() {
        let stored = seal("sk-test-1234567890");
        assert!(stored.starts_with(PREFIX));
        assert!(!stored.contains("sk-test"));
        assert_eq!(open(&stored), "sk-test-1234567890");
    }
}
