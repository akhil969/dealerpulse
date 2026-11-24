"""Same published worked examples as frontend/src/lib/anomaly/stats.test.ts."""
import math

import pytest

from dealerpulse.domain.anomaly import stats as s

NIST_90 = [30, 171, 184, 201, 212, 250, 265, 270, 272, 289, 305, 306, 322, 322, 336, 346, 351, 370, 390, 404, 409, 411,
           436, 437, 439, 441, 444, 448, 451, 453, 470, 480, 482, 487, 494, 495, 499, 503, 514, 521, 522, 527, 548, 550, 559,
           560, 570, 572, 574, 578, 585, 592, 592, 607, 616, 618, 621, 629, 637, 638, 640, 656, 668, 707, 709, 719, 737, 739,
           752, 758, 766, 792, 792, 794, 802, 818, 830, 832, 843, 858, 860, 869, 918, 925, 953, 991, 1000, 1005, 1068, 1441]


def test_quantiles_and_fences_match_nist_7_1_6():
    assert s.median(NIST_90) == pytest.approx(559.5)
    assert s.quantile(NIST_90, 0.25) == pytest.approx(429.75)
    assert s.quantile(NIST_90, 0.75) == pytest.approx(742.25)
    f = s.tukey_fences(NIST_90)
    assert (f.inner_low, f.inner_high, f.outer_high) == pytest.approx((-39.0, 1211.0, 1679.75))
    assert [x for x in NIST_90 if s.fence_level(x, f)] == [1441]


def test_modified_z():
    m = s.modified_z([1, 2, 3, 4, 100])
    assert m[4] == pytest.approx(0.6745 * 97)
    assert m[2] == 0


def test_ewma_matches_nist_6_3_2_4():
    ys = [52.0, 47.0, 53.0, 49.3, 50.1, 47.0, 51.0, 50.1, 51.2, 50.5, 49.6, 47.6, 49.9, 51.3, 47.8, 51.2, 52.6, 52.4, 53.6, 52.1]
    nist = [50.60, 49.52, 50.56, 50.18, 50.16, 49.21, 49.75, 49.85, 50.26, 50.33, 50.11, 49.36, 49.52, 50.05, 49.38, 49.92,
            50.73, 51.23, 51.94, 51.99]
    out = s.ewma(ys, 50, 2.0539, 0.3, 3)
    assert [p.z for p in out] == pytest.approx(nist, abs=0.006)
    assert out[-1].ucl == pytest.approx(52.5884, abs=0.001)
    assert not any(p.out for p in out)


def test_chi_square_matches_nist_7_4_5():
    chi2, df, p = s.chi2_independence([[15, 21, 45, 13], [26, 31, 34, 5], [33, 17, 49, 20]])
    assert chi2 == pytest.approx(19.18, abs=0.01)
    assert df == 6
    assert p == pytest.approx(0.00387, abs=1e-4)
    assert s.chi2_sf(3.841459, 1) == pytest.approx(0.05, abs=1e-5)


def test_normal_poisson_proportions():
    assert s.normal_cdf(1.959964) == pytest.approx(0.975, abs=1e-6)
    assert s.poisson_cdf(2, 1) == pytest.approx(math.exp(-1) * 2.5, abs=1e-9)
    assert s.poisson_test(2, 12)[0] < 0.01
    z, _ = s.two_proportion_z(45, 100, 30, 100)
    assert z == pytest.approx(2.191, abs=0.001)
    assert s.wilson(8, 10) == pytest.approx((0.4902, 0.9433), abs=1e-4)
    assert s.two_proportion_z(5, 10, 0, 0) == (0.0, 1.0)  # no comparison group


def test_cusum_and_moving_range():
    assert all(p.signal is None for p in s.cusum([10, 11, 9, 10, 10, 11, 9], 10, 1))
    assert s.cusum([10, 10, 11.5, 11.5, 11.5, 11.5, 11.5, 11.5], 10, 1)[-1].signal == "high"
    assert s.sigma_from_moving_range([1, 3, 1, 3]) == pytest.approx(2 / 1.128)


def test_mahalanobis_and_inverse():
    inv = s.invert([[4, 7], [2, 6]])
    assert [v for row in inv for v in row] == pytest.approx([0.6, -0.7, -0.2, 0.4])
    assert s.invert([[1, 2], [2, 4]]) is None
    assert s.mahalanobis2([3, 4], [0, 0], [[1, 0], [0, 1]]) == pytest.approx(25)
    mu, cov = s.covariance([[1, 2], [3, 6], [5, 10]])
    assert mu == [3, 6] and cov[0][1] == pytest.approx(8)


def test_benjamini_hochberg():
    assert s.benjamini_hochberg([0.01, 0.04, 0.03, 0.005]) == pytest.approx([0.02, 0.04, 0.04, 0.02])
