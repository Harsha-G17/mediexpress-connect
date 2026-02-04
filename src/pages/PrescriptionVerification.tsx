
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

// Fuzzy matching function for prescription validation
const validatePrescription = (ocrText: string, medicineName: string): boolean => {
  // Strategy 1: Direct substring match
  if (ocrText.includes(medicineName)) {
    return true;
  }

  // Strategy 2: Match each word of the medicine name
  const medicineWords = medicineName.split(" ").filter(word => word.length > 2);
  const matchedWords = medicineWords.filter(word => ocrText.includes(word));
  if (matchedWords.length >= Math.ceil(medicineWords.length * 0.6)) {
    return true;
  }

  // Strategy 3: Check for partial matches (first 4+ characters of each word)
  const partialMatches = medicineWords.filter(word => {
    if (word.length >= 4) {
      const prefix = word.substring(0, 4);
      return ocrText.includes(prefix);
    }
    return ocrText.includes(word);
  });
  if (partialMatches.length >= Math.ceil(medicineWords.length * 0.5)) {
    return true;
  }

  // Strategy 4: Fuzzy match - check if words are similar (allow 1-2 char difference)
  const ocrWords = ocrText.split(" ");
  for (const medWord of medicineWords) {
    for (const ocrWord of ocrWords) {
      if (similarityScore(medWord, ocrWord) >= 0.75) {
        return true;
      }
    }
  }

  return false;
};

// Calculate similarity between two strings (0-1)
const similarityScore = (str1: string, str2: string): number => {
  if (str1 === str2) return 1;
  if (str1.length < 3 || str2.length < 3) return str1 === str2 ? 1 : 0;
  
  const longer = str1.length > str2.length ? str1 : str2;
  const shorter = str1.length > str2.length ? str2 : str1;
  
  if (longer.includes(shorter)) return shorter.length / longer.length;
  
  let matches = 0;
  for (let i = 0; i < shorter.length; i++) {
    if (longer.includes(shorter[i])) matches++;
  }
  return matches / longer.length;
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
      const cleanedText = extractedText.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
      const normalizedMedicineName = medicineName.toLowerCase().replace(/[^a-z0-9\s]/g, " ").trim();

      console.log("OCR Text:", cleanedText);
      console.log("Medicine to find:", normalizedMedicineName);

      setOcrText(extractedText);

      // Improved verification with multiple matching strategies
      const isVerified = validatePrescription(cleanedText, normalizedMedicineName);
      
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
