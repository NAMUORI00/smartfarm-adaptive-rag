from __future__ import annotations

from io import BytesIO

from pypdf import PdfReader
from pypdf.errors import PyPdfError


MAX_PDF_PAGES = 250
MAX_EXTRACTED_TEXT_CHARACTERS = 100_000
MAX_IMAGE_BYTES = 10 * 1024 * 1024


class PdfTextExtractionError(ValueError):
    """A PDF cannot be safely converted into searchable text."""


class ImageTextExtractionError(ValueError):
    """An image has no trustworthy text representation for indexing."""


def validate_image_payload(payload: bytes) -> None:
    """Accept only bounded JPG/PNG payloads before a captioning adapter sees them."""

    if not payload or len(payload) > MAX_IMAGE_BYTES:
        raise ImageTextExtractionError(f"Images must be between 1 byte and {MAX_IMAGE_BYTES // (1024 * 1024)} MiB.")
    is_png = payload.startswith(b"\x89PNG\r\n\x1a\n")
    is_jpeg = payload.startswith(b"\xff\xd8\xff")
    if not (is_png or is_jpeg):
        raise ImageTextExtractionError("Only valid JPG and PNG image payloads are accepted.")


def extract_image_text(payload: bytes, *, operator_caption: str | None = None) -> str:
    """Validate JPG/PNG input and return an explicit trusted caption.

    The caller may obtain the caption from an operator or a configured vision
    provider, but must retain that provenance in the indexed document profile.
    An uncaptioned image fails explicitly.
    """

    validate_image_payload(payload)
    caption = str(operator_caption or "").strip()
    if not caption:
        raise ImageTextExtractionError(
            "OCR/vision extraction is not configured. Add an operator-reviewed caption before indexing this image."
        )
    return caption


def extract_pdf_text(
    payload: bytes,
    *,
    max_pages: int = MAX_PDF_PAGES,
    max_characters: int = MAX_EXTRACTED_TEXT_CHARACTERS,
) -> str:
    """Extract embedded text only; OCR is intentionally outside this local prototype."""

    try:
        reader = PdfReader(BytesIO(payload))
        if len(reader.pages) > max_pages:
            raise PdfTextExtractionError(f"PDFs with more than {max_pages} pages are not accepted.")
        pages: list[str] = []
        extracted_characters = 0
        for page in reader.pages:
            page_text = (page.extract_text() or "").strip()
            extracted_characters += len(page_text)
            if extracted_characters > max_characters:
                raise PdfTextExtractionError(
                    f"Extracted PDF text exceeds the {max_characters}-character indexing limit."
                )
            if page_text:
                pages.append(page_text)
        text = "\n\n".join(pages).strip()
    except PdfTextExtractionError:
        raise
    except (OSError, ValueError, KeyError, TypeError, PyPdfError) as error:
        raise PdfTextExtractionError("The PDF could not be read as text.") from error
    if not text:
        raise PdfTextExtractionError(
            "No extractable text was found in this PDF. Scanned or image-only PDFs require OCR, which is not enabled in the local prototype."
        )
    return text
