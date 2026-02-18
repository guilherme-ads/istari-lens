from __future__ import annotations

from app.modules.security.adapters.fernet_encryptor import credential_encryptor
from app.modules.security.domain.ports import SecretsVaultPort


class FernetSecretsVaultAdapter(SecretsVaultPort):
    """MVP vault adapter backed by existing Fernet encryption key from env."""

    def encrypt(self, plaintext: str) -> str:
        return credential_encryptor.encrypt(plaintext)

    def decrypt(self, ciphertext: str) -> str:
        return credential_encryptor.decrypt(ciphertext)


