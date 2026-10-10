"""doctext: PDF → plain text through pypdf (engine "Stages", ingest documents)."""

from conftest import run_tool, stderr_error, validate
from pypdf import PdfWriter
from pypdf.generic import (
    DecodedStreamObject,
    DictionaryObject,
    NameObject,
)


def make_pdf(path, pages):
    writer = PdfWriter()
    font = DictionaryObject(
        {
            NameObject("/Type"): NameObject("/Font"),
            NameObject("/Subtype"): NameObject("/Type1"),
            NameObject("/BaseFont"): NameObject("/Helvetica"),
        }
    )
    for text in pages:
        page = writer.add_blank_page(width=612, height=792)
        stream = DecodedStreamObject()
        stream.set_data(f"BT /F1 24 Tf 72 700 Td ({text}) Tj ET".encode("latin-1"))
        page[NameObject("/Contents")] = writer._add_object(stream)
        page[NameObject("/Resources")] = DictionaryObject(
            {NameObject("/Font"): DictionaryObject({NameObject("/F1"): font})}
        )
    with open(path, "wb") as fh:
        writer.write(fh)


def test_pdf_becomes_plain_text(tmp_path):
    pdf = tmp_path / "script.pdf"
    make_pdf(pdf, ["Scene one: the harbour at dawn", "Scene two: the market"])
    request = {"path": str(pdf)}
    validate("doctext.request.json", request)
    code, result, stderr = run_tool("doctext", request)
    assert code == 0, stderr
    validate("doctext.result.json", result)
    assert result["pages"] == 2
    assert "Scene one: the harbour at dawn" in result["text"]
    assert "Scene two: the market" in result["text"]
    assert result["text"].index("Scene one") < result["text"].index("Scene two")


def test_missing_file_fails_with_input_not_found(tmp_path):
    code, _, stderr = run_tool("doctext", {"path": str(tmp_path / "nope.pdf")})
    assert code == 1
    assert stderr_error(stderr)["code"] == "INPUT_NOT_FOUND"


def test_non_pdf_fails_with_doc_unreadable(tmp_path):
    fake = tmp_path / "fake.pdf"
    fake.write_text("<html>not a pdf</html>")
    code, _, stderr = run_tool("doctext", {"path": str(fake)})
    assert code == 1
    assert stderr_error(stderr)["code"] == "DOC_UNREADABLE"


def test_encrypted_pdf_fails_with_doc_encrypted(tmp_path):
    plain = tmp_path / "plain.pdf"
    make_pdf(plain, ["secret"])
    from pypdf import PdfReader

    writer = PdfWriter(clone_from=PdfReader(plain))
    writer.encrypt(user_password="pw", owner_password="owner", algorithm="RC4-128")
    locked = tmp_path / "locked.pdf"
    with open(locked, "wb") as fh:
        writer.write(fh)
    code, _, stderr = run_tool("doctext", {"path": str(locked)})
    assert code == 1
    assert stderr_error(stderr)["code"] == "DOC_ENCRYPTED"
