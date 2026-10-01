"""Compare full report text, order, status, persistence, and original hashes."""

from examples.check_reports import check_reports


def test_reports_against_known_content(tmp_path):
    checks = check_reports(tmp_path)
    assert len(checks) == 4
    for check in checks:
        assert check["passed"], check
