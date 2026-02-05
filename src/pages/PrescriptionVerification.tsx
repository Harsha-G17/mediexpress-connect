
import { useState, useEffect } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { supabase } from "@/integrations/supabase/client";
import Tesseract from "tesseract.js";
import { FileText, CheckCircle, XCircle } from "lucide-react";

// Levenshtein distance for accurate fuzzy matching
const levenshteinDistance = (str1: string, str2: string): number => {
  const m = str1.length;
  const n = str2.length;
  const dp: number[][] = Array(m + 1).fill(null).map(() => Array(n + 1).fill(0));

  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (str1[i - 1] === str2[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1];
      } else {
        dp[i][j] = 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
      }
    }
  }
  return dp[m][n];
};

// Normalize text for comparison (handles OCR common errors)
const normalizeForOCR = (text: string): string => {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ") // Remove special chars
    .replace(/0/g, "o")           // OCR often confuses 0 and o
    .replace(/1/g, "l")           // OCR often confuses 1 and l
    .replace(/5/g, "s")           // OCR often confuses 5 and s
    .replace(/8/g, "b")           // OCR often confuses 8 and b
    .replace(/\s+/g, " ")         // Normalize whitespace
    .trim();
};

// Calculate similarity score between two strings (0-1)
const similarityScore = (str1: string, str2: string): number => {
  if (str1 === str2) return 1;
  if (str1.length === 0 || str2.length === 0) return 0;
  
  const distance = levenshteinDistance(str1, str2);
  const maxLength = Math.max(str1.length, str2.length);
  return 1 - (distance / maxLength);
};

// Fuzzy matching function for prescription validation
const validatePrescription = (ocrText: string, medicineName: string): { isValid: boolean; confidence: number } => {
  const normalizedOCR = normalizeForOCR(ocrText);
  const normalizedMedicine = normalizeForOCR(medicineName);
  
  console.log("Normalized OCR:", normalizedOCR);
  console.log("Normalized Medicine:", normalizedMedicine);

  // Strategy 1: Direct substring match (100% confidence)
  if (normalizedOCR.includes(normalizedMedicine)) {
    console.log("Strategy 1: Direct match found");
    return { isValid: true, confidence: 100 };
  }

  // Strategy 2: Word-by-word matching
  const medicineWords = normalizedMedicine.split(" ").filter(word => word.length >= 3);
  const ocrWords = normalizedOCR.split(" ").filter(word => word.length >= 2);
  
  if (medicineWords.length === 0) {
    // Single short word - check if it exists
    if (normalizedOCR.includes(normalizedMedicine)) {
      return { isValid: true, confidence: 100 };
    }
  }

  // Check each medicine word against OCR words
  let matchedWords = 0;
  let totalScore = 0;
  
  for (const medWord of medicineWords) {
    let bestMatch = 0;
    
    // Check direct inclusion
    if (normalizedOCR.includes(medWord)) {
      matchedWords++;
      totalScore += 1;
      console.log(`Word "${medWord}" found directly`);
      continue;
    }
    
    // Check similarity with each OCR word
    for (const ocrWord of ocrWords) {
      const score = similarityScore(medWord, ocrWord);
      if (score > bestMatch) {
        bestMatch = score;
      }
    }
    
    if (bestMatch >= 0.7) {
      matchedWords++;
      totalScore += bestMatch;
      console.log(`Word "${medWord}" matched with score ${bestMatch.toFixed(2)}`);
    }
  }

  const matchRatio = medicineWords.length > 0 ? matchedWords / medicineWords.length : 0;
  const avgScore = medicineWords.length > 0 ? totalScore / medicineWords.length : 0;
  
  console.log(`Match ratio: ${matchRatio.toFixed(2)}, Avg score: ${avgScore.toFixed(2)}`);

  // Strategy 3: At least 60% of words match with good similarity
  if (matchRatio >= 0.6 && avgScore >= 0.5) {
    return { isValid: true, confidence: Math.round(avgScore * 100) };
  }

  // Strategy 4: Check if medicine name appears as a continuous substring with minor variations
  for (const ocrWord of ocrWords) {
    if (ocrWord.length >= normalizedMedicine.length - 2) {
      const score = similarityScore(ocrWord, normalizedMedicine);
      if (score >= 0.75) {
        console.log(`Fuzzy match found: "${ocrWord}" ~ "${normalizedMedicine}" (${score.toFixed(2)})`);
        return { isValid: true, confidence: Math.round(score * 100) };
      }
    }
  }

  // Strategy 5: Check prefix matching (first 4+ characters)
  const medicinePrefix = normalizedMedicine.substring(0, Math.min(5, normalizedMedicine.length));
  if (normalizedOCR.includes(medicinePrefix)) {
    console.log(`Prefix match found: "${medicinePrefix}"`);
    return { isValid: true, confidence: 70 };
  }

  return { isValid: false, confidence: 0 };
};

const PrescriptionVerification = () => {
  const [file, setFile] = useState<File | null>(null);
  const [loading, setLoading] = useState(false);
  const [ocrText, setOcrText] = useState<string | null>(null);
  const [verificationResult, setVerificationResult] = useState<'pending' | 'success' | 'failed'>('pending');

  const { toast } = useToast();
  const navigate = useNavigate();
  const location = useLocation();

  // Extract medicine name & price from URL
  const queryParams = new URLSearchParams(location.search);
  const medicineName = queryParams.get("medicine") || "";
  const medicinePrice = queryParams.get("price") || "0";

  useEffect(() => {
    if (!medicineName) {
      navigate("/products");
    }
  }, [medicineName, navigate]);

  const processOCR = async (file: File): Promise<string> => {
    try {
      const { data } = await Tesseract.recognize(file, "eng", {
        logger: (info) => console.log(info),
      });
      return data.text;
    } catch (error) {
      throw new Error("Failed to process OCR on the prescription.");
    }
  };

  const uploadToStorage = async (file: File): Promise<string> => {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) throw new Error("User not authenticated");

    const fileName = `verification_${user.id}_${Date.now()}_${file.name}`;
    const { data, error } = await supabase.storage
      .from("prescriptions")
      .upload(fileName, file);

    if (error) throw error;
    
    const { data: { publicUrl } } = supabase.storage
      .from("prescriptions")
      .getPublicUrl(fileName);

    return publicUrl;
  };

  const savePrescription = async (fileUrl: string, medicine: string, status: string) => {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) throw new Error("User not authenticated");

    const { error } = await supabase
      .from("prescriptions")
      .insert({
        user_id: user.id,
        file_url: fileUrl,
        medicine_name: medicine,
        status: status
      });

    if (error) throw error;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!file) {
      toast({
        title: "Error",
        description: "Please upload a prescription file.",
        variant: "destructive",
      });
      return;
    }

    setLoading(true);
    setOcrText(null);
    setVerificationResult('pending');

    try {
      // Check authentication
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) {
        toast({
          title: "Authentication Required",
          description: "Please login to verify prescriptions.",
          variant: "destructive",
        });
        navigate("/auth");
        return;
      }

      toast({
        title: "Processing...",
        description: "Analyzing the prescription. Please wait.",
      });

      // Process OCR
      const extractedText = await processOCR(file);
      
      console.log("Raw OCR Text:", extractedText);
      console.log("Medicine to find:", medicineName);

      setOcrText(extractedText);

      // Improved verification with multiple matching strategies
      const { isValid: isVerified, confidence } = validatePrescription(extractedText, medicineName);
      console.log(`Verification result: ${isVerified}, Confidence: ${confidence}%`);
      
      // Upload file to storage
      const fileUrl = await uploadToStorage(file);
      
      // Save prescription with verification status
      await savePrescription(fileUrl, medicineName, isVerified ? "approved" : "rejected");

      if (isVerified) {
        setVerificationResult('success');
        toast({
          title: "Verification Successful",
          description: "Prescription verified successfully. You can now proceed to checkout.",
        });
        
        // Auto-redirect to checkout after 2 seconds
        setTimeout(() => {
          navigate(`/checkout?product=${encodeURIComponent(medicineName)}&price=${medicinePrice}`);
        }, 2000);
      } else {
        setVerificationResult('failed');
        toast({
          title: "Verification Failed",
          description: `The uploaded prescription does not include the required medicine: ${medicineName}.`,
          variant: "destructive",
        });
      }

    } catch (error: any) {
      console.error("Verification error:", error);
      setVerificationResult('failed');
      toast({
        title: "Error",
        description: error.message || "An unexpected error occurred during verification.",
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="container mx-auto px-4 py-8">
      <Card className="max-w-2xl mx-auto">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <FileText className="w-5 h-5" />
            Prescription Verification
          </CardTitle>
          <div className="space-y-1">
            <p className="text-sm text-gray-600">Medicine: <strong>{medicineName}</strong></p>
            <p className="text-sm text-gray-600">Price: <strong>₹{medicinePrice}</strong></p>
          </div>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-6">
            <div>
              <Label htmlFor="file">Upload your prescription:</Label>
              <Input
                type="file"
                id="file"
                accept="image/*,.pdf"
                onChange={(e) => setFile(e.target.files?.[0] || null)}
                required
                className="mt-1"
              />
            </div>

            {/* Verification Result */}
            {verificationResult !== 'pending' && (
              <div className={`p-4 rounded-lg border ${
                verificationResult === 'success' 
                  ? 'bg-green-50 border-green-200' 
                  : 'bg-red-50 border-red-200'
              }`}>
                <div className="flex items-center gap-2">
                  {verificationResult === 'success' ? (
                    <CheckCircle className="w-5 h-5 text-green-600" />
                  ) : (
                    <XCircle className="w-5 h-5 text-red-600" />
                  )}
                  <h3 className={`font-semibold ${
                    verificationResult === 'success' ? 'text-green-800' : 'text-red-800'
                  }`}>
                    {verificationResult === 'success' ? 'Verification Successful' : 'Verification Failed'}
                  </h3>
                </div>
                <p className={`text-sm mt-1 ${
                  verificationResult === 'success' ? 'text-green-700' : 'text-red-700'
                }`}>
                  {verificationResult === 'success' 
                    ? `Prescription verified for ${medicineName}. Redirecting to checkout...`
                    : `The prescription does not match the required medicine: ${medicineName}`
                  }
                </p>
              </div>
            )}

            {/* OCR Results */}
            {ocrText && (
              <div className="mt-4 p-4 bg-gray-50 rounded-lg">
                <h3 className="font-semibold mb-2">Extracted Text:</h3>
                <p className="text-sm whitespace-pre-wrap text-gray-700">{ocrText}</p>
              </div>
            )}

            <div className="flex gap-4">
              <Button type="submit" className="flex-1" disabled={loading}>
                {loading ? "Verifying..." : "Verify Prescription"}
              </Button>
              
              {verificationResult === 'failed' && (
                <Button 
                  type="button" 
                  variant="outline" 
                  onClick={() => navigate(-1)}
                  className="flex-1"
                >
                  Try Again
                </Button>
              )}
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
};

export default PrescriptionVerification;
