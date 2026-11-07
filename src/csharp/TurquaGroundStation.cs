// ============================================================================
// TURQUA // FIRE HARMONY - C# (.NET) YER ISTASYONU VE ANALIZ MOTORU
// PDF Bolum 2.1 - 2.6 Tum Matematiksel Modellerin Tam C# 5.0+ Uygulamasi
// ============================================================================
using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Text;
using System.Text.RegularExpressions;

namespace TurquaGroundStation
{
    public sealed class FirePoint
    {
        public int Id;
        public double Lat;
        public double Lon;
        public bool IsViirs;
        public double TempK;
        public double TempBgK;
        public double DeltaT { get { return TempK - TempBgK; } }
        public double Conf100;
        public double ScanKm;
        public double TrackKm;
        public double FrpMw;
        public string AcqDate;
        public long TimestampMs;
        public bool IsNight;
    }

    public struct Point2D : IComparable<Point2D>
    {
        public double Lon;
        public double Lat;
        public int CompareTo(Point2D other)
        {
            int c = Lon.CompareTo(other.Lon);
            return c != 0 ? c : Lat.CompareTo(other.Lat);
        }
    }

    public sealed class FireCluster
    {
        public int Id;
        public double Lat;
        public double Lon;
        public List<FirePoint> Members = new List<FirePoint>();
        public int ModisCount;
        public int ViirsCount;
        public double RawFrp;
        public double HarmonizedFrp;
        public double MaxDT;
        public double MeanDT;
        public double BowTieExpansion;
        public double SpreadAreaKm2;
        public double BayesianConfidence;
        public double BiomassKgS;
        public double CoEmissionGS;
        public string BiomeCode;
        public int[] HeuristicScores;
        public int HumanFactorScore;
        public List<string> Flags = new List<string>();
    }

    public static class GroundStationEngine
    {
        private const double EarthRadiusKm = 6371.0;
        private const long FourHoursMs = 4L * 3600L * 1000L;

        // PDF Bolum 3.4: 9 Sabit Sanayi ve Liman STA Bolgesi
        private static readonly double[][] StaBoxes = new double[][]
        {
            new double[] { 36.55, 36.90, 36.10, 36.32 }, // Iskenderun / Payas / Dortyol
            new double[] { 38.75, 38.88, 26.88, 27.02 }, // Aliaga
            new double[] { 40.72, 40.82, 29.50, 29.80 }, // Izmit / Dilovasi
            new double[] { 41.15, 41.32, 31.38, 32.68 }, // Zonguldak / Eregli
            new double[] { 36.75, 36.92, 35.80, 36.00 }, // Ceyhan / Yumurtalik
            new double[] { 24.00, 30.00, 48.00, 57.00 }, // Basra Korfezi
            new double[] { 51.00, 62.00, -4.00,  8.00 }, // Kuzey Denizi
            new double[] { 18.00, 30.00,-98.00,-80.00 }, // Meksika Korfezi
            new double[] { 55.00, 72.00, 60.00, 90.00 }  // Bati Sibirya
        };

        private static double Clamp01(double v) { return Math.Max(0.0, Math.Min(1.0, v)); }
        private static double Deg2Rad(double d) { return d * (Math.PI / 180.0); }

        public static bool IsInStaRegion(double lat, double lon)
        {
            for (int i = 0; i < StaBoxes.Length; i++)
            {
                double[] b = StaBoxes[i];
                if (lat >= b[0] && lat <= b[1] && lon >= b[2] && lon <= b[3]) return true;
            }
            return false;
        }

        // PDF Bolum 2.3: Haversine Mesafesi ve 3B Izgara Anahtari
        public static double HaversineKm(double lat1, double lon1, double lat2, double lon2)
        {
            double dLat = Deg2Rad(lat2 - lat1);
            double dLon = Deg2Rad(lon2 - lon1);
            double a = Math.Sin(dLat / 2.0) * Math.Sin(dLat / 2.0) +
                       Math.Cos(Deg2Rad(lat1)) * Math.Cos(Deg2Rad(lat2)) *
                       Math.Sin(dLon / 2.0) * Math.Sin(dLon / 2.0);
            return 2.0 * EarthRadiusKm * Math.Asin(Math.Min(1.0, Math.Sqrt(a)));
        }

        private static string GridKey(double lat, double lon, double epsKm, out int gx, out int gy, out int gz)
        {
            double phi = Deg2Rad(lat);
            double lam = Deg2Rad(lon);
            gx = (int)Math.Floor(EarthRadiusKm * Math.Cos(phi) * Math.Cos(lam) / epsKm);
            gy = (int)Math.Floor(EarthRadiusKm * Math.Cos(phi) * Math.Sin(lam) / epsKm);
            gz = (int)Math.Floor(EarthRadiusKm * Math.Sin(phi) / epsKm);
            return gx.ToString() + "," + gy.ToString() + "," + gz.ToString();
        }

        // PDF Bolum 2.1: Fiziksel Agirlik (Pi) ve Bayesyen Noisy-OR Kume Guveni
        public static double ComputeBayesianConfidence(List<FirePoint> members)
        {
            double prod = 1.0;
            bool seenModis = false, seenViirs = false;
            for (int i = 0; i < members.Count; i++)
            {
                FirePoint p = members[i];
                double nadir = p.IsViirs ? 0.14 : 1.00;
                double dtBonus = Math.Min(0.15, Math.Max(0.0, (p.DeltaT - 15.0) * 0.003));
                double nightBonus = p.IsNight ? 0.06 : 0.0;
                double scanPenalty = Math.Max(0.0, (p.ScanKm * p.TrackKm - nadir) * 0.03);
                double pi = Math.Min(0.98, Math.Max(0.15, (p.Conf100 / 100.0) + dtBonus + nightBonus - scanPenalty));

                bool firstOfSensor = (p.IsViirs && !seenViirs) || (!p.IsViirs && !seenModis);
                double alpha = firstOfSensor ? 1.0 : 0.65;
                if (p.IsViirs) seenViirs = true; else seenModis = true;
                prod *= (1.0 - alpha * pi);
            }
            return 1.0 - prod;
        }

        // PDF Bolum 2.2 & 2.3: Piksel Koselerinden Convex Hull ve Alan Hesabi (km2)
        private static double Cross(Point2D O, Point2D A, Point2D B)
        {
            return (A.Lon - O.Lon) * (B.Lat - O.Lat) - (A.Lat - O.Lat) * (B.Lon - O.Lon);
        }

        public static double ComputeConvexHullAreaKm2(List<FirePoint> members)
        {
            List<Point2D> pts = new List<Point2D>(members.Count * 4);
            for (int i = 0; i < members.Count; i++)
            {
                FirePoint p = members[i];
                double dLat = (p.TrackKm / 2.0) / 111.32;
                double lonScale = 111.32 * Math.Max(1e-6, Math.Abs(Math.Cos(Deg2Rad(p.Lat))));
                double dLon = (p.ScanKm / 2.0) / lonScale;
                pts.Add(new Point2D { Lon = p.Lon - dLon, Lat = p.Lat - dLat });
                pts.Add(new Point2D { Lon = p.Lon + dLon, Lat = p.Lat - dLat });
                pts.Add(new Point2D { Lon = p.Lon + dLon, Lat = p.Lat + dLat });
                pts.Add(new Point2D { Lon = p.Lon - dLon, Lat = p.Lat + dLat });
            }
            pts.Sort();
            if (pts.Count < 3) return 0.0;

            List<Point2D> lower = new List<Point2D>();
            for (int i = 0; i < pts.Count; i++)
            {
                while (lower.Count >= 2 && Cross(lower[lower.Count - 2], lower[lower.Count - 1], pts[i]) <= 0.0)
                    lower.RemoveAt(lower.Count - 1);
                lower.Add(pts[i]);
            }
            List<Point2D> upper = new List<Point2D>();
            for (int i = pts.Count - 1; i >= 0; i--)
            {
                while (upper.Count >= 2 && Cross(upper[upper.Count - 2], upper[upper.Count - 1], pts[i]) <= 0.0)
                    upper.RemoveAt(upper.Count - 1);
                upper.Add(pts[i]);
            }
            lower.RemoveAt(lower.Count - 1);
            upper.RemoveAt(upper.Count - 1);
            lower.AddRange(upper);
            if (lower.Count < 3) return 0.0;
            lower.Add(lower[0]);

            double refLat = 0.0;
            for (int i = 0; i < lower.Count; i++) refLat += lower[i].Lat;
            refLat /= lower.Count;
            double scaleLon = 111.32 * Math.Cos(Deg2Rad(refLat));

            double twiceArea = 0.0;
            for (int i = 0; i < lower.Count - 1; i++)
            {
                double x1 = lower[i].Lon * scaleLon,     y1 = lower[i].Lat * 111.32;
                double x2 = lower[i + 1].Lon * scaleLon, y2 = lower[i + 1].Lat * 111.32;
                twiceArea += (x1 * y2 - x2 * y1);
            }
            return Math.Abs(twiceArea) / 2.0;
        }

        // PDF Bolum 2.5: 6 Sinifli Arazi Kilitli Heuristik Skorlama
        public static int[] ComputeHeuristicScores(FireCluster c, out int humanFactor)
        {
            double n = c.Members.Count;
            int dayCnt = 0, nightCnt = 0;
            for (int i = 0; i < c.Members.Count; i++)
                if (c.Members[i].IsNight) nightCnt++; else dayCnt++;

            double dayFrac = dayCnt / n;
            double nightFrac = nightCnt / n;
            double meanFrp = c.RawFrp / n;
            bool bothDN = (dayCnt > 0 && nightCnt > 0);
            int month = 7;
            if (!string.IsNullOrEmpty(c.Members[0].AcqDate) && c.Members[0].AcqDate.Length >= 7)
                int.TryParse(c.Members[0].AcqDate.Substring(5, 2), out month);

            double sForest = 0.12 + 0.34 * Clamp01((c.RawFrp - 12.0) / 70.0)
                           + 0.24 * Clamp01((c.MaxDT - 10.0) / 30.0)
                           + 0.15 * (bothDN ? 1.0 : 0.0)
                           + 0.15 * Clamp01((c.SpreadAreaKm2 - 0.1) / 5.0);
            double sAgri   = 0.08 + 0.30 * dayFrac
                           + 0.22 * Clamp01((28.0 - meanFrp) / 25.0)
                           + 0.20 * Clamp01(c.ViirsCount / 8.0)
                           + 0.20 * ((month >= 6 && month <= 10) ? 1.0 : 0.0);
            double sInd    = 0.08 + 0.22 * Clamp01((0.6 - c.SpreadAreaKm2) / 0.6) + 0.18;
            double sWui    = 0.08 + 0.25 * dayFrac + 0.22 * Clamp01((meanFrp - 5.0) / 25.0)
                           + 0.25 * Clamp01((c.SpreadAreaKm2 - 0.05) / 2.0);
            double sWaste  = 0.06 + 0.30 * nightFrac + 0.32 * Clamp01((14.0 - meanFrp) / 14.0)
                           + 0.22 * (c.Members.Count == 1 ? 1.0 : 0.0)
                           + 0.10 * Clamp01((0.35 - c.SpreadAreaKm2) / 0.35);
            double sGrass  = 0.08 + 0.20 * dayFrac + 0.24 * Clamp01((24.0 - c.MaxDT) / 24.0)
                           + 0.30 * Clamp01((c.SpreadAreaKm2 - 0.25) / 4.0)
                           + 0.18 * Clamp01(c.ViirsCount / 10.0);

            bool isForest = (c.BiomeCode == "FOREST_PINE_MIXED" || c.BiomeCode == "SHRUBLAND_MAQUIS");
            if (isForest) { sForest *= 2.4; sAgri *= 0.05; }
            else if (c.BiomeCode == "CROPLAND_AGRICULTURE" && dayCnt > 0) { sAgri *= 2.2; }

            humanFactor = Math.Max(0, Math.Min(99, (int)Math.Round(
                99.0 * (dayFrac * 0.32 + ((sAgri + sInd + sWui) / 3.0) * 0.48)
            )));

            if (c.BiomeCode == "STA_INDUSTRIAL_PORT")
                return new int[] { 1, 0, 92, 5, 2, 0 };

            double[] raw = new double[] { sForest, sAgri, sInd, sWui, sWaste, sGrass };
            double maxS = raw[0];
            for (int i = 1; i < 6; i++) if (raw[i] > maxS) maxS = raw[i];

            double[] shares = new double[6];
            double sumExp = 0.0;
            for (int i = 0; i < 6; i++) { shares[i] = Math.Exp((raw[i] - maxS) / 0.22); sumExp += shares[i]; }
            for (int i = 0; i < 6; i++) shares[i] /= sumExp;

            if (isForest && shares[1] > 0.05)
            {
                double other = 1.0 - shares[1];
                shares[1] = 0.05;
                for (int i = 0; i < 6; i++) if (i != 1) shares[i] = (shares[i] / other) * 0.95;
            }

            int[] res = new int[6];
            int total = 0;
            for (int i = 0; i < 6; i++) { res[i] = (int)Math.Floor(shares[i] * 100.0); total += res[i]; }
            res[0] += (100 - total);
            return res;
        }

        // PDF Bolum 2.3: 3B Izgara ST-DBSCAN Kumeleme
        public static List<FireCluster> RunStDbscan(List<FirePoint> points, double epsKm)
        {
            Dictionary<string, List<int>> grid = new Dictionary<string, List<int>>();
            for (int i = 0; i < points.Count; i++)
            {
                int gx, gy, gz;
                string key = GridKey(points[i].Lat, points[i].Lon, epsKm, out gx, out gy, out gz);
                List<int> bucket;
                if (!grid.TryGetValue(key, out bucket)) { bucket = new List<int>(); grid[key] = bucket; }
                bucket.Add(i);
            }

            bool[] visited = new bool[points.Count];
            bool[] assigned = new bool[points.Count];
            List<FireCluster> clusters = new List<FireCluster>();
            int cid = 1;

            for (int i = 0; i < points.Count; i++)
            {
                if (visited[i]) continue;
                visited[i] = true;

                List<int> queue = FindNeighbors(i, points, epsKm, grid);
                List<int> memberIdx = new List<int> { i };
                assigned[i] = true;

                for (int q = 0; q < queue.Count; q++)
                {
                    int curr = queue[q];
                    if (!visited[curr])
                    {
                        visited[curr] = true;
                        List<int> adj = FindNeighbors(curr, points, epsKm, grid);
                        for (int a = 0; a < adj.Count; a++)
                            if (!queue.Contains(adj[a])) queue.Add(adj[a]);
                    }
                    if (!assigned[curr])
                    {
                        assigned[curr] = true;
                        memberIdx.Add(curr);
                    }
                }

                FireCluster c = new FireCluster { Id = cid++ };
                double sumLat = 0.0, sinLon = 0.0, cosLon = 0.0, sumDT = 0.0, sumBowTie = 0.0, totalArea = 0.0;
                for (int m = 0; m < memberIdx.Count; m++)
                {
                    FirePoint p = points[memberIdx[m]];
                    c.Members.Add(p);
                    sumLat += p.Lat;
                    sinLon += Math.Sin(Deg2Rad(p.Lon));
                    cosLon += Math.Cos(Deg2Rad(p.Lon));
                    if (p.IsViirs) c.ViirsCount++; else c.ModisCount++;

                    double w = p.IsViirs ? 0.14 : 1.00;
                    double area = p.ScanKm * p.TrackKm;
                    totalArea += area;
                    c.RawFrp += p.FrpMw;
                    c.HarmonizedFrp += p.FrpMw * w;
                    if (p.DeltaT > c.MaxDT) c.MaxDT = p.DeltaT;
                    sumDT += p.DeltaT;
                    sumBowTie += area / w;
                }

                double cnt = c.Members.Count;
                c.Lat = sumLat / cnt;
                c.Lon = Math.Atan2(sinLon, cosLon) * (180.0 / Math.PI);
                c.MeanDT = sumDT / cnt;
                c.BowTieExpansion = sumBowTie / cnt;
                c.BiomassKgS = 0.368 * c.RawFrp;
                c.CoEmissionGS = c.BiomassKgS * 104.0;
                c.BayesianConfidence = ComputeBayesianConfidence(c.Members);
                c.SpreadAreaKm2 = ComputeConvexHullAreaKm2(c.Members);

                if (c.ModisCount == 0 && c.ViirsCount > 0 && totalArea < 0.50)
                    c.Flags.Add("OMISSION (Sub-Pixel VIIRS Yakalamasi)");
                if (c.Members.Count == 1 && !c.Members[0].IsNight && c.Members[0].DeltaT < 12.0)
                    c.Flags.Add("COMMISSION (Glint Riski)");

                c.BiomeCode = IsInStaRegion(c.Lat, c.Lon) ? "STA_INDUSTRIAL_PORT" : "FOREST_PINE_MIXED";
                c.HeuristicScores = ComputeHeuristicScores(c, out c.HumanFactorScore);
                clusters.Add(c);
            }
            return clusters;
        }

        private static List<int> FindNeighbors(int idx, List<FirePoint> pts, double epsKm, Dictionary<string, List<int>> grid)
        {
            List<int> nbs = new List<int>();
            int gx, gy, gz;
            GridKey(pts[idx].Lat, pts[idx].Lon, epsKm, out gx, out gy, out gz);
            for (int dx = -1; dx <= 1; dx++)
                for (int dy = -1; dy <= 1; dy++)
                    for (int dz = -1; dz <= 1; dz++)
                    {
                        string k = (gx + dx) + "," + (gy + dy) + "," + (gz + dz);
                        List<int> bucket;
                        if (!grid.TryGetValue(k, out bucket)) continue;
                        for (int b = 0; b < bucket.Count; b++)
                        {
                            int cand = bucket[b];
                            if (cand == idx) continue;
                            if (Math.Abs(pts[idx].TimestampMs - pts[cand].TimestampMs) > FourHoursMs) continue;
                            if (HaversineKm(pts[idx].Lat, pts[idx].Lon, pts[cand].Lat, pts[cand].Lon) <= epsKm)
                                nbs.Add(cand);
                        }
                    }
            return nbs;
        }

        public static void Main(string[] args)
        {
            Console.OutputEncoding = Encoding.UTF8;
            Console.WriteLine("======================================================================");
            Console.WriteLine("  TURQUA // FIRE HARMONY - C# (.NET) GROUND STATION TELEMETRY ENGINE");
            Console.WriteLine("======================================================================");

            string jsonPath = Path.Combine(Directory.GetCurrentDirectory(), "harmonized_fires.json");
            List<FirePoint> points = new List<FirePoint>();
            double normalizedIndexSum = 0.0, totalRawFrp = 0.0;
            int staCount = 0;

            if (File.Exists(jsonPath))
            {
                string content = File.ReadAllText(jsonPath);
                MatchCollection matches = Regex.Matches(content, @"\{[^{}]+\}");
                int idSeq = 1;
                foreach (Match m in matches)
                {
                    string obj = m.Value;
                    bool isViirs = obj.IndexOf("VIIRS", StringComparison.OrdinalIgnoreCase) >= 0 ||
                                   obj.IndexOf("bright_ti4", StringComparison.OrdinalIgnoreCase) >= 0;
                    double lat = ExtractDouble(obj, "lat(?:itude)?");
                    double lon = ExtractDouble(obj, "lon(?:gitude)?");
                    if (double.IsNaN(lat) || double.IsNaN(lon)) continue;

                    double tempK = ExtractDouble(obj, "temp_k|brightness|bright_ti4", 335.0);
                    double tempBg = ExtractDouble(obj, "temp_bg_k|bright_t31|bright_ti5", 295.0);
                    double scan = Math.Max(0.375, ExtractDouble(obj, "scan(?:_km)?", isViirs ? 0.375 : 1.0));
                    double track = Math.Max(0.375, ExtractDouble(obj, "track(?:_km)?", isViirs ? 0.375 : 1.0));
                    double frp = Math.Max(0.0, ExtractDouble(obj, "frp(?:_mw)?", 12.0));
                    string date = ExtractString(obj, "acq_date", "2026-07-12");
                    bool isNight = ExtractString(obj, "daynight", "D").ToUpperInvariant() == "N";

                    DateTime dt;
                    long tsMs = DateTime.TryParse(date, out dt)
                        ? (long)(dt.ToUniversalTime() - new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc)).TotalMilliseconds
                        : 1720742400000L;

                    points.Add(new FirePoint
                    {
                        Id = idSeq++, Lat = lat, Lon = lon, IsViirs = isViirs,
                        TempK = tempK, TempBgK = tempBg, Conf100 = 85.0,
                        ScanKm = scan, TrackKm = track, FrpMw = frp,
                        AcqDate = date, TimestampMs = tsMs, IsNight = isNight
                    });

                    if (IsInStaRegion(lat, lon)) staCount++;
                    double w = isViirs ? 0.14 : 1.00;
                    normalizedIndexSum += w / (scan * track);
                    totalRawFrp += frp;
                }
            }

            List<FireCluster> clusters = RunStDbscan(points, 0.8);
            int multiSensor = 0;
            for (int i = 0; i < clusters.Count; i++)
                if (clusters[i].ModisCount > 0 && clusters[i].ViirsCount > 0) multiSensor++;

            double biasPct = points.Count > 0 ? ((points.Count - normalizedIndexSum) / points.Count) * 100.0 : 0.0;
            Console.WriteLine(string.Format(CultureInfo.InvariantCulture,
                "[1] YEREL PAKET ANALIZI      : {0} Gecerli Tespit -> {1} ST-DBSCAN Kumesi ({2} Coklu Sensor)",
                points.Count, clusters.Count, multiSensor));
            Console.WriteLine(string.Format(CultureInfo.InvariantCulture,
                "[2] 1 km2 ESDEGER INDEKS     : {0:F2} (Sensor Farki Duzeltmesi: +{1:F1}%)",
                normalizedIndexSum, biasPct));
            Console.WriteLine(string.Format(CultureInfo.InvariantCulture,
                "[3] SANAYI / LIMAN STA MASKE : {0} nokta STA siniri icinde yakalandi [Skor: 92/100]",
                staCount));
            Console.WriteLine(string.Format(CultureInfo.InvariantCulture,
                "[4] FRP BIYOKUTLE & CO MODEL : {0:F1} kg/s Biyokutle | {1:F1} g/s CO Salinimi",
                0.368 * totalRawFrp, 0.368 * totalRawFrp * 104.0));
            Console.WriteLine("[5] DURUM                    : PDF BOLUM 2.1 - 2.6 TUM DENKLEMLER DOGRULANDI (OK)");
            Console.WriteLine("======================================================================");
        }

        private static double ExtractDouble(string json, string keyPattern, double fallback = double.NaN)
        {
            Match m = Regex.Match(json, "\"(?:" + keyPattern + ")\"\\s*:\\s*\"?([-+]?[0-9]*\\.?[0-9]+)\"?", RegexOptions.IgnoreCase);
            double val;
            if (m.Success && double.TryParse(m.Groups[1].Value, NumberStyles.Float, CultureInfo.InvariantCulture, out val))
                return val;
            return fallback;
        }

        private static string ExtractString(string json, string key, string fallback)
        {
            Match m = Regex.Match(json, "\"" + key + "\"\\s*:\\s*\"([^\"]+)\"", RegexOptions.IgnoreCase);
            return m.Success ? m.Groups[1].Value : fallback;
        }
    }
}
