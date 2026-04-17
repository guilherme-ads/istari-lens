from __future__ import annotations


class OpenAIAdapterError(Exception):
    def __init__(self, message: str, *, code: str = "openai_adapter_error") -> None:
        super().__init__(message)
        self.code = code


class OpenAIAdapterHTTPError(OpenAIAdapterError):
    def __init__(
        self,
        message: str,
        *,
        status_code: int,
        detail: str | None = None,
        code: str = "openai_http_error",
    ) -> None:
        super().__init__(message, code=code)
        self.status_code = int(status_code)
        self.detail = detail


class OpenAIAdapterParsingError(OpenAIAdapterError):
    def __init__(self, message: str, *, code: str = "openai_parsing_error") -> None:
        super().__init__(message, code=code)


class OpenAIAdapterSchemaError(OpenAIAdapterError):
    def __init__(self, message: str, *, code: str = "openai_schema_error") -> None:
        super().__init__(message, code=code)
