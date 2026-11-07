// ============================================================================
// TURQUA // FIRE HARMONY - C++17 UYDU HARMONIZASYON VE FIZIK CEKIRDEGI
// NASA Space Apps Challenge 2026 - Tam Matematiksel Referans Uygulamasi
// ============================================================================
#include <iostream>
#include <vector>
#include <cmath>
#include <unordered_map>
#include <string>
#include <algorithm>
#include <array>
#include <chrono>
#include <iomanip>

namespace TurquaCore {

    constexpr double PI = 3.14159265358979323846;
    constexpr double EARTH_RADIUS_KM = 6371.0;
    constexpr double MODIS_NADIR_KM2 = 1.00;
    constexpr double VIIRS_NADIR_KM2 = 0.14;
    constexpr double BIOMASS_COEFF = 0.368;      // kg/MJ
    constexpr double CO_FACTOR = 104.0;          // g/kg
    constexpr long long FOUR_HOURS_MS = 4LL * 3600LL * 1000LL;

    inline double clamp01(double v) { return std::max(0.0, std::min(1.0, v)); }
    inline double deg2rad(double d) { return d * (PI / 180.0); }

    enum class Sensor { MODIS = 0, VIIRS = 1 };

    struct Point2D {
        double lon, lat;
        bool operator<(const Point2D& o) const {
            return (lon < o.lon) || (lon == o.lon && lat < o.lat);
        }
    };

    struct Detection {
        int id;
        double lat, lon;
        Sensor sensor;
        double temp_k;          // MODIS: brightness | VIIRS: bright_ti4
        double temp_bg_k;       // MODIS: bright_t31 | VIIRS: bright_ti5
        double delta_t;         // temp_k - temp_bg_k
        double conf_100;        // 0-100 sayisal esdeger (Noisy-OR icin)
        std::string conf_raw;   // Ham kaynak confidence
        double scan_km, track_km;
        long long ts_ms;
        std::string acq_date;
        bool is_night;          // daynight == 'N'
        double frp_mw;
    };

    struct ErrorFlag {
        std::string code;
        std::string message;
    };

    struct ClusterResult {
        int id;
        double lat, lon;
        int modis_count = 0;
        int viirs_count = 0;
        double raw_frp = 0.0;
        double harmonized_frp = 0.0;
        double max_dt = 0.0;
        double mean_dt = 0.0;
        double bow_tie_expansion = 0.0;
        double spread_area_km2 = 0.0;
        double bayesian_confidence = 0.0;
        double biomass_kg_s = 0.0;
        double co_g_s = 0.0;
        int human_factor_score = 0;
        std::string biome_code;
        std::string regime_label;
        std::array<int, 6> heuristic_scores{};
        std::vector<ErrorFlag> flags;
        std::vector<Point2D> hull;
    };

    struct StaRegion {
        const char* name;
        double min_lat, max_lat, min_lon, max_lon;
    };

    // PDF Bolum 3.4: 9 Sabit Sanayi ve Liman STA Bolgesi
    const std::vector<StaRegion> STA_REGIONS = {
        {"Iskenderun / Payas / Dortyol Demir-Celik Hatti", 36.55, 36.90, 36.10, 36.32},
        {"Aliaga Rafineri ve Gemi Sokum Sahasi",           38.75, 38.88, 26.88, 27.02},
        {"Izmit / Dilovasi / Tupras Sanayi Sahasi",        40.72, 40.82, 29.50, 29.80},
        {"Zonguldak / Eregli Agir Sanayi Sahasi",          41.15, 41.32, 31.38, 32.68},
        {"Ceyhan / Yumurtalik Terminal Sahasi",            36.75, 36.92, 35.80, 36.00},
        {"Basra Korfezi Petrol ve Gaz Havzasi",            24.00, 30.00, 48.00, 57.00},
        {"Kuzey Denizi Petrol ve Gaz Havzasi",             51.00, 62.00, -4.00,  8.00},
        {"Meksika Korfezi Petrol ve Gaz Havzasi",          18.00, 30.00,-98.00,-80.00},
        {"Bati Sibirya Petrol ve Gaz Havzasi",             55.00, 72.00, 60.00, 90.00}
    };

    // PDF Bolum 2.1: Fiziksel Nokta Agirligi (Pi) ve Bayesyen Noisy-OR Kume Guveni
    double computePointPhysicalProbability(const Detection& p) {
        double nadir = (p.sensor == Sensor::MODIS) ? MODIS_NADIR_KM2 : VIIRS_NADIR_KM2;
        double dt_bonus = std::min(0.15, std::max(0.0, (p.delta_t - 15.0) * 0.003));
        double night_bonus = p.is_night ? 0.06 : 0.0;
        double scan_penalty = std::max(0.0, (p.scan_km * p.track_km - nadir) * 0.03);
        double prob = (p.conf_100 / 100.0) + dt_bonus + night_bonus - scan_penalty;
        return std::min(0.98, std::max(0.15, prob));
    }

    double computeBayesianNoisyOr(const std::vector<const Detection*>& members) {
        double prod = 1.0;
        bool seen_modis = false, seen_viirs = false;
        for (const auto* m : members) {
            double pi = computePointPhysicalProbability(*m);
            bool first_of_sensor = (m->sensor == Sensor::MODIS && !seen_modis) ||
                                   (m->sensor == Sensor::VIIRS && !seen_viirs);
            double alpha = first_of_sensor ? 1.0 : 0.65;
            if (m->sensor == Sensor::MODIS) seen_modis = true;
            else seen_viirs = true;
            prod *= (1.0 - alpha * pi);
        }
        return 1.0 - prod;
    }

    // PDF Bolum 2.1: Omission ve Commission Hata Bayraklari
    std::vector<ErrorFlag> classifyErrors(const std::vector<const Detection*>& members) {
        std::vector<ErrorFlag> flags;
        bool has_modis = false, has_viirs = false;
        double total_area = 0.0;
        for (const auto* m : members) {
            if (m->sensor == Sensor::MODIS) has_modis = true;
            else has_viirs = true;
            total_area += (m->scan_km * m->track_km);
        }
        if (!has_modis && has_viirs && total_area < 0.50) {
            flags.push_back({"OMISSION", "SUB-PIXEL DETECTION (MODIS Omission Yakalandi)"});
        }
        if (members.size() == 1 && !members[0]->is_night && members[0]->delta_t < 12.0) {
            flags.push_back({"COMMISSION", "LOW THERMAL ANOMALY / GLINT RISK (Commission Uyarisi)"});
        }
        return flags;
    }

    // PDF Bolum 2.2: Gercek Piksel Ayak Izi 4 Kose Koordinati
    std::array<Point2D, 4> footprintCorners(const Detection& p) {
        double half_track_deg = (p.track_km / 2.0) / 111.32;
        double lon_scale = 111.32 * std::max(1e-6, std::abs(std::cos(deg2rad(p.lat))));
        double half_scan_deg = (p.scan_km / 2.0) / lon_scale;
        return {{
            {p.lon - half_scan_deg, p.lat - half_track_deg},
            {p.lon + half_scan_deg, p.lat - half_track_deg},
            {p.lon + half_scan_deg, p.lat + half_track_deg},
            {p.lon - half_scan_deg, p.lat + half_track_deg}
        }};
    }

    // PDF Bolum 2.3: Monotone Chain Convex Hull ve Shoelace (Gauss) Poligon Alani (km2)
    double crossProduct(const Point2D& O, const Point2D& A, const Point2D& B) {
        return (A.lon - O.lon) * (B.lat - O.lat) - (A.lat - O.lat) * (B.lon - O.lon);
    }

    std::vector<Point2D> computeConvexHull(const std::vector<const Detection*>& members) {
        std::vector<Point2D> pts;
        pts.reserve(members.size() * 4);
        for (const auto* m : members) {
            auto corners = footprintCorners(*m);
            pts.insert(pts.end(), corners.begin(), corners.end());
        }
        std::sort(pts.begin(), pts.end());
        if (pts.size() < 3) return {};

        std::vector<Point2D> lower, upper;
        for (const auto& p : pts) {
            while (lower.size() >= 2 && crossProduct(lower[lower.size()-2], lower.back(), p) <= 0.0)
                lower.pop_back();
            lower.push_back(p);
        }
        for (int i = static_cast<int>(pts.size()) - 1; i >= 0; --i) {
            while (upper.size() >= 2 && crossProduct(upper[upper.size()-2], upper.back(), pts[i]) <= 0.0)
                upper.pop_back();
            upper.push_back(pts[i]);
        }
        lower.pop_back();
        upper.pop_back();
        lower.insert(lower.end(), upper.begin(), upper.end());
        if (lower.size() >= 3) lower.push_back(lower.front());
        return lower;
    }

    double computeHullAreaKm2(const std::vector<Point2D>& hull) {
        if (hull.size() < 4) return 0.0;
        double ref_lat = 0.0;
        for (const auto& p : hull) ref_lat += p.lat;
        ref_lat /= static_cast<double>(hull.size());
        double lon_scale = 111.32 * std::cos(deg2rad(ref_lat));

        double twice_area = 0.0;
        for (size_t i = 0; i + 1 < hull.size(); ++i) {
            double x1 = hull[i].lon * lon_scale,     y1 = hull[i].lat * 111.32;
            double x2 = hull[i+1].lon * lon_scale,   y2 = hull[i+1].lat * 111.32;
            twice_area += (x1 * y2 - x2 * y1);
        }
        return std::abs(twice_area) / 2.0;
    }

    // PDF Bolum 2.3: Haversine ve 3B Kartezyen Izgara (ST-DBSCAN)
    double haversineKm(double lat1, double lon1, double lat2, double lon2) {
        double dLat = deg2rad(lat2 - lat1);
        double dLon = deg2rad(lon2 - lon1);
        double a = std::sin(dLat / 2.0) * std::sin(dLat / 2.0) +
                   std::cos(deg2rad(lat1)) * std::cos(deg2rad(lat2)) *
                   std::sin(dLon / 2.0) * std::sin(dLon / 2.0);
        return 2.0 * EARTH_RADIUS_KM * std::asin(std::min(1.0, std::sqrt(a)));
    }

    struct GridCell {
        int x, y, z;
        bool operator==(const GridCell& o) const { return x == o.x && y == o.y && z == o.z; }
    };

    struct GridCellHash {
        std::size_t operator()(const GridCell& c) const {
            return ((std::hash<int>()(c.x) ^ (std::hash<int>()(c.y) << 1)) >> 1) ^ (std::hash<int>()(c.z) << 1);
        }
    };

    GridCell toGridCell(double lat, double lon, double eps_km) {
        double phi = deg2rad(lat), lam = deg2rad(lon);
        return {
            static_cast<int>(std::floor(EARTH_RADIUS_KM * std::cos(phi) * std::cos(lam) / eps_km)),
            static_cast<int>(std::floor(EARTH_RADIUS_KM * std::cos(phi) * std::sin(lam) / eps_km)),
            static_cast<int>(std::floor(EARTH_RADIUS_KM * std::sin(phi) / eps_km))
        };
    }

    std::string detectBiomeCode(double lat, double lon) {
        for (const auto& r : STA_REGIONS) {
            if (lat >= r.min_lat && lat <= r.max_lat && lon >= r.min_lon && lon <= r.max_lon)
                return "STA_INDUSTRIAL_PORT";
        }
        bool coastal_forest = (lat >= 35.8 && lat <= 38.5 && lon >= 26.0 && lon <= 36.5) ||
                              (lat >= 38.5 && lat <= 41.8 && lon >= 26.0 && lon <= 30.5);
        return coastal_forest ? "FOREST_PINE_MIXED" : "CROPLAND_AGRICULTURE";
    }

    // PDF Bolum 2.5: 6 Sinifli Arazi Kilitli Heuristik Skorlama ve Insan Etkisi
    std::array<int, 6> computeHeuristicScores(
        double total_frp, double mean_frp, double max_dt,
        double day_fraction, double night_fraction, int viirs_count,
        int member_count, int month, double spread_area_km2,
        int repeat_5km, int repeat_10km, double delta_t_std,
        const std::string& biome_code, int& out_human_factor
    ) {
        bool both_dn = (day_fraction > 0.0 && night_fraction > 0.0);
        double s_forest = 0.12 + 0.34 * clamp01((total_frp - 12.0) / 70.0)
                        + 0.24 * clamp01((max_dt - 10.0) / 30.0)
                        + 0.15 * (both_dn ? 1.0 : 0.0)
                        + 0.15 * clamp01((spread_area_km2 - 0.1) / 5.0);
        double s_agri   = 0.08 + 0.30 * day_fraction
                        + 0.22 * clamp01((28.0 - mean_frp) / 25.0)
                        + 0.20 * clamp01(viirs_count / 8.0)
                        + 0.20 * ((month >= 6 && month <= 10) ? 1.0 : 0.0);
        double s_ind    = 0.08 + 0.36 * clamp01(repeat_5km / 8.0)
                        + 0.22 * clamp01((0.6 - spread_area_km2) / 0.6)
                        + 0.18 * clamp01((8.0 - delta_t_std) / 8.0)
                        + 0.16 * clamp01(repeat_5km / 5.0);
        double s_wui    = 0.08 + 0.25 * day_fraction
                        + 0.22 * clamp01((mean_frp - 5.0) / 25.0)
                        + 0.20 * clamp01(repeat_10km / 10.0)
                        + 0.25 * clamp01((spread_area_km2 - 0.05) / 2.0);
        double s_waste  = 0.06 + 0.30 * night_fraction
                        + 0.32 * clamp01((14.0 - mean_frp) / 14.0)
                        + 0.22 * (member_count == 1 ? 1.0 : 0.0)
                        + 0.10 * clamp01((0.35 - spread_area_km2) / 0.35);
        double s_grass  = 0.08 + 0.20 * day_fraction
                        + 0.24 * clamp01((24.0 - max_dt) / 24.0)
                        + 0.30 * clamp01((spread_area_km2 - 0.25) / 4.0)
                        + 0.18 * clamp01(viirs_count / 10.0);

        bool is_forest = (biome_code == "FOREST_PINE_MIXED" || biome_code == "SHRUBLAND_MAQUIS");
        if (is_forest) { s_forest *= 2.4; s_agri *= 0.05; }
        else if (biome_code == "CROPLAND_AGRICULTURE" && day_fraction > 0.0) { s_agri *= 2.2; }
        else if (biome_code == "NON_FUEL_SURFACE") { s_forest *= 0.05; s_agri *= 0.05; s_grass *= 0.05; }

        out_human_factor = std::max(0, std::min(99, static_cast<int>(std::round(
            99.0 * (day_fraction * 0.32 + ((s_agri + s_ind + s_wui) / 3.0) * 0.48 + clamp01(repeat_10km / 20.0) * 0.20)
        ))));

        if (biome_code == "STA_INDUSTRIAL_PORT") {
            return {1, 0, 92, 5, 2, 0};
        }

        std::array<double, 6> raw = {s_forest, s_agri, s_ind, s_wui, s_waste, s_grass};
        double max_s = *std::max_element(raw.begin(), raw.end());
        std::array<double, 6> shares{};
        double sum_exp = 0.0;
        for (int i = 0; i < 6; ++i) {
            shares[i] = std::exp((raw[i] - max_s) / 0.22);
            sum_exp += shares[i];
        }
        for (int i = 0; i < 6; ++i) shares[i] /= sum_exp;

        if (is_forest && shares[1] > 0.05) {
            double other = 1.0 - shares[1];
            shares[1] = 0.05;
            for (int i = 0; i < 6; ++i) if (i != 1) shares[i] = (shares[i] / other) * 0.95;
        }

        std::array<int, 6> result{};
        int sum_int = 0;
        for (int i = 0; i < 6; ++i) { result[i] = static_cast<int>(std::floor(shares[i] * 100.0)); sum_int += result[i]; }
        result[0] += (100 - sum_int);
        return result;
    }

    // Tam ST-DBSCAN + Küme Fiziği Çalıştırıcısı
    std::vector<ClusterResult> executeStDbscan(const std::vector<Detection>& points, double eps_km = 0.8) {
        std::unordered_map<GridCell, std::vector<size_t>, GridCellHash> grid;
        for (size_t i = 0; i < points.size(); ++i) {
            grid[toGridCell(points[i].lat, points[i].lon, eps_km)].push_back(i);
        }

        auto getNeighbors = [&](size_t idx) {
            std::vector<size_t> nbs;
            GridCell c = toGridCell(points[idx].lat, points[idx].lon, eps_km);
            for (int dx = -1; dx <= 1; ++dx)
                for (int dy = -1; dy <= 1; ++dy)
                    for (int dz = -1; dz <= 1; ++dz) {
                        auto it = grid.find({c.x + dx, c.y + dy, c.z + dz});
                        if (it == grid.end()) continue;
                        for (size_t cand : it->second) {
                            if (cand == idx) continue;
                            if (std::llabs(points[idx].ts_ms - points[cand].ts_ms) > FOUR_HOURS_MS) continue;
                            if (haversineKm(points[idx].lat, points[idx].lon, points[cand].lat, points[cand].lon) <= eps_km)
                                nbs.push_back(cand);
                        }
                    }
            return nbs;
        };

        std::vector<uint8_t> visited(points.size(), 0), assigned(points.size(), 0);
        std::vector<ClusterResult> results;
        int cluster_id = 1;

        for (size_t i = 0; i < points.size(); ++i) {
            if (visited[i]) continue;
            visited[i] = 1;
            std::vector<size_t> queue = getNeighbors(i);
            std::vector<size_t> member_indices = {i};
            assigned[i] = 1;

            for (size_t q = 0; q < queue.size(); ++q) {
                size_t curr = queue[q];
                if (!visited[curr]) {
                    visited[curr] = 1;
                    for (size_t adj : getNeighbors(curr)) {
                        if (std::find(queue.begin(), queue.end(), adj) == queue.end())
                            queue.push_back(adj);
                    }
                }
                if (!assigned[curr]) {
                    assigned[curr] = 1;
                    member_indices.push_back(curr);
                }
            }

            ClusterResult cr;
            cr.id = cluster_id++;
            std::vector<const Detection*> members;
            double sum_lat = 0.0, sin_lon = 0.0, cos_lon = 0.0, sum_dt = 0.0, sum_bowtie = 0.0;
            int day_cnt = 0, night_cnt = 0;

            for (size_t idx : member_indices) {
                const auto& p = points[idx];
                members.push_back(&p);
                sum_lat += p.lat;
                sin_lon += std::sin(deg2rad(p.lon));
                cos_lon += std::cos(deg2rad(p.lon));
                if (p.sensor == Sensor::MODIS) cr.modis_count++;
                else cr.viirs_count++;
                if (p.is_night) night_cnt++; else day_cnt++;

                double w = (p.sensor == Sensor::MODIS) ? MODIS_NADIR_KM2 : VIIRS_NADIR_KM2;
                cr.raw_frp += p.frp_mw;
                cr.harmonized_frp += p.frp_mw * w;
                cr.max_dt = std::max(cr.max_dt, p.delta_t);
                sum_dt += p.delta_t;
                sum_bowtie += (p.scan_km * p.track_km) / w;
            }

            double n = static_cast<double>(members.size());
            cr.lat = sum_lat / n;
            cr.lon = std::atan2(sin_lon, cos_lon) * (180.0 / PI);
            cr.mean_dt = sum_dt / n;
            cr.bow_tie_expansion = sum_bowtie / n;
            cr.biomass_kg_s = BIOMASS_COEFF * cr.raw_frp;
            cr.co_g_s = cr.biomass_kg_s * CO_FACTOR;
            cr.bayesian_confidence = computeBayesianNoisyOr(members);
            cr.flags = classifyErrors(members);
            cr.hull = computeConvexHull(members);
            cr.spread_area_km2 = computeHullAreaKm2(cr.hull);
            cr.biome_code = detectBiomeCode(cr.lat, cr.lon);

            int month = std::stoi(members[0]->acq_date.substr(5, 2));
            cr.heuristic_scores = computeHeuristicScores(
                cr.raw_frp, cr.raw_frp / n, cr.max_dt,
                day_cnt / n, night_cnt / n, cr.viirs_count,
                static_cast<int>(members.size()), month, cr.spread_area_km2,
                0, 0, 0.0, cr.biome_code, cr.human_factor_score
            );
            results.push_back(cr);
        }
        return results;
    }
}

int main() {
    using namespace TurquaCore;
    std::vector<Detection> sample = {
        {1, 36.8210, 28.2610, Sensor::MODIS, 368.4, 298.1, 70.3, 94.0, "94", 1.15, 1.02, 1720780800000LL, "2026-07-12", false, 112.5},
        {2, 36.8225, 28.2630, Sensor::VIIRS, 381.2, 297.8, 83.4, 90.0, "h",  0.41, 0.38, 1720784400000LL, "2026-07-12", true,   74.0},
        {3, 36.7540, 36.2110, Sensor::VIIRS, 331.0, 299.0, 32.0, 80.0, "n",  0.39, 0.37, 1720785000000LL, "2026-07-12", false,  21.4}
    };
    auto clusters = executeStDbscan(sample, 0.8);
    std::cout << "[TURQUA C++17 CORE] " << clusters.size() << " kume islendi.\n";
    return 0;
}
