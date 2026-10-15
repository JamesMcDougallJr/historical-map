# Object storage for ingested documents: the original bytes and their text
# artifacts, which the ingest workers write and the web app's
# /api/documents/[id]/source route links to.
#
# This used to stay in the operator's local MinIO (plans/10-deployment.md), on
# the theory that Postgres was the only thing the deployed web app and the local
# workers share. The "view source" link broke that theory: it redirects the
# *browser* to a presigned URL for the original, so the bytes must be somewhere
# the internet can reach. Until this existed, every source link on the deployed
# site returned 501.
#
# Private on purpose. Nothing is ever public: the web app presigns a 15-minute
# GET per click, and presigning is a local SigV4 computation, so Vercel's key
# only needs s3:GetObject.

resource "random_id" "documents_bucket" {
  byte_length = 4
}

resource "aws_s3_bucket" "documents" {
  # Bucket names are global across all of AWS; the suffix keeps this one unique.
  bucket = "${var.project_name}-documents-${random_id.documents_bucket.hex}"

  # Same teardown story as RDS's skip_final_snapshot: `tofu destroy` should
  # not need the bucket emptied by hand first. The originals are reproducible
  # from the corpus, and local MinIO keeps its own copy.
  force_destroy = true
}

resource "aws_s3_bucket_public_access_block" "documents" {
  bucket                  = aws_s3_bucket.documents.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "documents" {
  bucket = aws_s3_bucket.documents.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

# ── Web app (Vercel): presigns GETs, nothing else ────────────────────────────

resource "aws_iam_user" "documents_web" {
  name = "${var.project_name}-documents-web"
}

resource "aws_iam_user_policy" "documents_web" {
  name = "read-documents"
  user = aws_iam_user.documents_web.name
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["s3:GetObject"]
      Resource = "${aws_s3_bucket.documents.arn}/*"
    }]
  })
}

resource "aws_iam_access_key" "documents_web" {
  user = aws_iam_user.documents_web.name
}

# ── Ingest workers (local): read and write artifacts ─────────────────────────

resource "aws_iam_user" "documents_ingest" {
  name = "${var.project_name}-documents-ingest"
}

resource "aws_iam_user_policy" "documents_ingest" {
  name = "read-write-documents"
  user = aws_iam_user.documents_ingest.name
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"]
        Resource = "${aws_s3_bucket.documents.arn}/*"
      },
      {
        Effect   = "Allow"
        Action   = ["s3:ListBucket"]
        Resource = aws_s3_bucket.documents.arn
      },
    ]
  })
}

resource "aws_iam_access_key" "documents_ingest" {
  user = aws_iam_user.documents_ingest.name
}
