"""Encryption utilities for storing sensitive credentials."""
from cryptography.fernet import Fernet
from app.shared.infrastructure.settings import settings


class CredentialEncryption:
    """Encrypt/decrypt database credentials."""
    
    def __init__(self, key: str = None):
        key = key or settings.encryption_key
        if not key:
            raise ValueError("ENCRYPTION_KEY not set in environment")
        self.cipher = Fernet(key.encode() if isinstance(key, str) else key)
    
    def encrypt(self, plaintext: str) -> str:
        """Encrypt a string."""
        return self.cipher.encrypt(plaintext.encode()).decode()
    
    def decrypt(self, ciphertext: str) -> str:
        """Decrypt a string."""
        return self.cipher.decrypt(ciphertext.encode()).decode()


# Global instance
credential_encryptor = CredentialEncryption()

