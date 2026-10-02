# Filewise document dataset

Milestone 4 prepares data for the Milestone 5 text classifier (TF-IDF + Logistic
Regression). Training is separate from the application; these scripts never read
connected Drive accounts. No model is trained or installed by this milestone.

## What is included

The default generated corpus contains 1,600 English synthetic document scenarios:
200 each for marksheets, educational certificates, utility bills, invoices,
receipts, land records, bank statements, and prescriptions. There are ten template
families per class and twenty scenarios per family. These are **template-derived
examples**, not 1,600 independent real documents. Read `categories.json` for exact
definitions, exclusions and category-box mappings.

Each scenario is saved as one original TXT file and processed through the existing
Milestone 2 extractor. Its actual extraction output is used in the JSONL dataset.
Do not duplicate TXT/PDF/DOCX copies as independent training observations.

The builder also creates twelve synthetic out-of-scope challenge documents and
160 PNG scans (clear/degraded pairs of eighty documents). PNGs have expected text
for future OCR comparisons; they **do not contain actual OCR results** and are not
included in train/validation/test. Their group/split stays tied to the TXT parent.

Any permitted public receipts collected for this release are a separate reference
corpus. See `source_research.json` for publisher/license evidence and the dataset's
`public_reference/` folder. Public receipt OCR annotations are not Filewise OCR
output. A single public class in another language cannot serve as an eight-class
English classification benchmark.

## Commands (from the repository root)

Use the existing project virtual environment with development dependencies,
including Pillow >=10.1 for the optional PNG examples.

```powershell
.venv\Scripts\python.exe -m training.prepare_dataset
.venv\Scripts\python.exe -m training.validate_dataset storage/datasets/filewise-v1
```

The builder and validator both save `validation_report.json`. Open the generated
`preview.html` in a browser to browse one example per template in each category.

To reproduce the public reference collection (network access required only for
download), then include its verified cache in a fresh dataset:

```powershell
.venv\Scripts\python.exe -m training.download_public_receipts
.venv\Scripts\python.exe -m training.download_public_receipts --verify-only
.venv\Scripts\python.exe -m training.prepare_dataset --output storage/datasets/filewise-v2 --public-cache storage/datasets/source-cache
```

The downloaded subset is 75 publisher-validation and 75 publisher-test receipts.
One pair has identical selected annotation text across those official splits; the
pair shares a conservative group ID and is flagged in the download report. No
public reference record is silently promoted into a classifier split. Publisher
merchant/template groups are unknown, and those original splits are not claimed
to be leakage-free for this application.

To make a smaller fresh dataset for debugging:

```powershell
.venv\Scripts\python.exe -m training.prepare_dataset --output storage/datasets/small-run --per-template 2 --no-images
```

The builder refuses to overwrite existing directories. Use a new version directory
for a rebuild. A `BUILD_IN_PROGRESS.json` marker indicates an incomplete generation;
do not train from an interrupted build. The completed dataset includes generator
hashes, dependency versions, seed, explicit group assignments and file checksums.
The same generator/configuration produces the same document text, IDs and splits;
extraction timestamps intentionally differ. Keep each released manifest immutable.

## Simple file structure

```text
training/
  categories.json          # Edit document definitions and box mappings here
  synthetic_documents.py   # Content templates and consistent generated values
  prepare_dataset.py       # Extract, split, and export records
  validate_dataset.py      # Schema, provenance, file integrity and leakage checks
  check_artifacts.py       # PNG parent/split checks and public annotation integrity
  download_public_receipts.py # Optional licensed public reference downloader
  source_research.json     # Public source decisions and license evidence

storage/datasets/filewise-v1/     # Generated data; ignored by Git
  originals/                    # Synthetic TXT originals
  extractions/                  # Actual Milestone 2 extraction JSON
  labels.csv                    # Easy-to-read index; not a second authoritative store
  manifest.jsonl                # Authoritative labeled records
  train.jsonl
  validation.jsonl
  test.jsonl
  challenge.jsonl               # Unsupported types; label/category null
  ocr_pending/                  # Simulated scans, not real camera photos
  ocr_pending.jsonl             # Expected text only; not training-eligible
  categories.json
  sources.json
  build_config.json
  checksums.json
  validation_report.json
  preview.html                  # Browse sample documents by category
  public_reference/             # Separately licensed public receipt corpus
```

`labels.csv` is an inspection/export convenience. Editing it alone does not change
the authoritative JSONL data. Change templates for generated examples and rebuild
a new version. For real examples, retain immutable originals and provenance, then
assemble reviewed labels using the same record schema. Never infer a category
solely from a filename or extraction status.

## Record schema

One JSON object per line represents a whole document, not a page or text chunk.
Main records contain:

| Field | Meaning |
|---|---|
| `document_id` | Opaque stable ID; contains no category name |
| `label`, `category` | Specific type and broader UI box; not model inputs |
| `text` | Actual extracted text; the initial model input |
| `text_sha256`, `original_sha256` | Content integrity and exact-copy checks |
| `original_path`, `extraction_path` | Dataset-relative original and extractor result |
| `group_id`, `template_id` | Related versions/templates stay in one split |
| `source_id`, `source_url`, `license`, `license_url` | Traceable source/usage basis |
| `is_synthetic`, `language`, `review_status` | Origin, language and label provenance |
| `extraction_status`, `extractor`, `extractor_version` | Processing provenance |
| `text_origin` | Live extractor versus publisher annotation |
| `split` | Train, validation, test, or out-of-scope challenge |

Synthetic labels are rule-assigned (`synthetic_rule_labeled`), not independently
human-reviewed. Labels follow the document purpose. The eight known types are
mutually exclusive for this initial single-label task; mixed-purpose bundles and
unfamiliar types should be reviewed. `needs_ocr` describes extraction, whereas
`needs_review` is a future classification/application decision.

## Splits and leakage

Ten global template families are assigned with seed 42: six to training, two to
validation, and two to testing. This gives 960/320/320 documents (60/20/20), with
each class represented in all three. Every category using a shared family stays
in its assigned split. Keeping groups intact matters more than exact percentages.

The validator checks schema, record/export equality, source fields, hashes,
original paths, class coverage, and exact/group/template split leakage. Its
near-duplicate heuristic reports candidates for review; passing it does not prove
the absence of semantic leakage. Templates still share a common generator,
vocabulary and artificial patterns. Synthetic held-out results are workflow checks,
**not evidence of real-world classification accuracy**.

Optional artifacts are also checked: pending images must match their parent
document's label/group/split/expected text; public images and annotations must
match saved hashes, publisher text and license/attribution records. This validation
does not claim the publisher annotation includes every visible word.

Only use `record['text']` as baseline input and `record['label']` as the target.
Do not feed IDs, source, filename, group, split or synthetic flags to the model.
Fit TF-IDF and any learned preprocessing on training data only. Tune parameters
and a Needs Review policy on validation data. Keep the final real evaluation set
untouched during model development. Do not merge public reference receipts into
this benchmark without designing a language/source-balanced collection first.

## Limits and next collection priorities

This release is a usable synthetic bootstrap and extraction/OCR test resource,
not a production-ready document classifier dataset. It makes no accuracy claim.

- Only English generated text; regional scripts and multilingual layouts are absent.
- Land records are generic fictional parcel forms, not sale deeds or regional forms.
- Prescription examples omit real medication/dosage instructions and handwriting.
- OCR images are simulated typewritten scans; real camera conditions need evaluation.
- Public receipt annotations provide only one real class and their own domain/language.
- The twelve challenge examples are a small diagnostic set, not representative unknowns.
- No real independently reviewed test set across all eight classes is available yet.

For the next version, collect permitted real examples of all supported classes,
record source/template families, validate labels, run the actual OCR pipeline when
available, and freeze an independent real test set. Add data where measured errors
show gaps. Users' connected Drive files must not silently become training data.

## Dataset storage with DVC and Google Drive

DVC tracks `storage/datasets/filewise-v1` through the small
`storage/datasets/filewise-v1.dvc` pointer. The configured `gdrive` remote stores
the data in the [Google Drive DVC folder](https://drive.google.com/drive/folders/1xmPY69LZ07IWkmCHA9e0nyMddMIHlYW8).
DVC stores content-addressed
objects there; use `dvc pull` to restore the original filenames and folders.

Install DVC in its own environment to keep its Google Drive dependencies separate
from the application:

```powershell
py -3.12 -m venv .venv-dvc
.venv-dvc\Scripts\python.exe -m pip install -r training/requirements-dvc.txt
```

Each collaborator needs access to the remote folder and must authorize their own
Google account. If Google's shared DVC sign-in app is blocked, follow the
[custom Desktop OAuth client setup](https://dvc.org/doc/user-guide/data-management/remote-storage/google-drive#using-a-custom-google-cloud-project-recommended).
Keep `gdrive_client_id` and `gdrive_client_secret` in `.dvc/config.local`
using DVC's `--local` option. Set `gdrive_user_credentials_file` locally to an
absolute path inside `.dvc/tmp/`. Both locations are ignored by Git. Do not commit
downloaded client JSON files or cached authorization tokens.

Once authorization is configured, download or verify the dataset:

```powershell
.venv-dvc\Scripts\dvc.exe pull storage/datasets/filewise-v1.dvc
.venv-dvc\Scripts\dvc.exe status storage/datasets/filewise-v1.dvc --cloud
```

After an intentional dataset update, validate it, update its pointer, and upload:

```powershell
.venv\Scripts\python.exe -m training.validate_dataset storage/datasets/filewise-v1
.venv-dvc\Scripts\dvc.exe add storage/datasets/filewise-v1
.venv-dvc\Scripts\dvc.exe push storage/datasets/filewise-v1.dvc
```

Commit preparation code, `.dvc/config`, `.dvc/.gitignore`, `.dvcignore`, the root
`.gitignore`, and dataset `.dvc` pointers so collaborators can retrieve the same
version. Generated datasets, source images, and private data remain Git-ignored
under `storage/`. Preserve publisher attribution and license copies with any
redistributed public subset.
