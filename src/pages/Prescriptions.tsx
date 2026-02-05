
import { useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { supabase } from "@/integrations/supabase/client";
import Tesseract from "tesseract.js";

// Normalizes text so "250mg" matches "250 mg" and ignores case/newlines/symbols
const normalizeCompact = (text: string) =>
  text.toLowerCase().replace(/[^a-z0-9]/g, "");

const Prescriptions = () => {
  const [file, setFile] = useState<File | null>(null);
  const [loading, setLoading] = useState(false);
  const [ocrText, setOcrText] = useState<string | null>(null);

  const { toast } = useToast();
  const navigate = useNavigate();
  const location = useLocation();

  const queryParams = new URLSearchParams(location.search);
  const medicineName = queryParams.get("medicine") || "";
  const medicinePrice = queryParams.get("price") || "0";

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

    const fileName = `${user.id}_${Date.now()}_${file.name}`;
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

    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) {
        toast({
          title: "Authentication Required",
          description: "Please login to continue.",
          variant: "destructive",
        });
        navigate("/auth");
        return;
      }

      toast({
        title: "Processing...",
        description: "Analyzing the prescription. Please wait.",
      });

      const extractedText = await processOCR(file);
      const compactOcr = normalizeCompact(extractedText);
      const compactMedicine = normalizeCompact(medicineName);

      setOcrText(extractedText);

      const fileUrl = await uploadToStorage(file);
      
      if (!compactOcr.includes(compactMedicine)) {
        await savePrescription(fileUrl, medicineName, "rejected");
        toast({
          title: "Invalid Prescription",
          description: `The uploaded prescription does not include the required medicine: ${medicineName}.`,
          variant: "destructive",
        });
        return;
      }

      await savePrescription(fileUrl, medicineName, "approved");
      toast({
        title: "Success",
        description: "Prescription verified successfully. Proceeding to checkout.",
      });

      navigate(`/checkout?product=${encodeURIComponent(medicineName)}&price=${medicinePrice}`);
    } catch (error: any) {
      toast({
        title: "Error",
        description: error.message || "An unexpected error occurred.",
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="container mx-auto px-4 py-8">
      <Card className="max-w-md mx-auto">
        <CardHeader>
          <CardTitle className="text-xl font-bold">Prescription Verification</CardTitle>
          <p className="text-gray-600">Medicine: <strong>{medicineName}</strong></p>
          <p className="text-gray-600">Price: <strong>₹{medicinePrice}</strong></p>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <Label htmlFor="file">Upload your prescription:</Label>
              <Input
                type="file"
                id="file"
                accept="image/*"
                onChange={(e) => setFile(e.target.files?.[0] || null)}
                required
              />
            </div>

            {ocrText && (
              <div className="mt-4 p-4 bg-gray-100 rounded">
                <h3 className="font-semibold">Extracted Text:</h3>
                <p className="text-sm whitespace-pre-wrap">{ocrText}</p>
              </div>
            )}

            <Button type="submit" className="w-full" disabled={loading}>
              {loading ? "Verifying..." : "Verify Prescription"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
};

export default Prescriptions;
