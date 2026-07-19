import { useState, useCallback, useRef } from "react";
import { useLocation } from "wouter";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Upload, FileText, AlertTriangle, Loader2 } from "lucide-react";
import { useCSVParser } from "../hooks/useCSVParser";
import type { CSVParseResult } from "../hooks/useCSVParser";

interface SearchTermUploaderProps {
  /** Whether a clientId is currently bound in the URL */
  clientId: number | null;
  /** Called when CSV is successfully parsed */
  onParsed: (result: CSVParseResult) => void;
  /** Trigger element — when clicked, opens the uploader */
  children: React.ReactNode;
}

export function SearchTermUploader({
  clientId,
  onParsed,
  children,
}: SearchTermUploaderProps) {
  const [, navigate] = useLocation();
  const [showNoClientAlert, setShowNoClientAlert] = useState(false);
  const [showUploadDialog, setShowUploadDialog] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { parseFile, isParsing, error } = useCSVParser();

  const handleTriggerClick = useCallback(() => {
    if (!clientId) {
      setShowNoClientAlert(true);
    } else {
      setShowUploadDialog(true);
    }
  }, [clientId]);

  const handleFile = useCallback(
    async (file: File) => {
      if (!file.name.toLowerCase().endsWith(".csv")) {
        return;
      }
      const result = await parseFile(file);
      if (result) {
        setShowUploadDialog(false);
        onParsed(result);
      }
    },
    [parseFile, onParsed]
  );

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragging(false);
      const file = e.dataTransfer.files[0];
      if (file) handleFile(file);
    },
    [handleFile]
  );

  const handleFileInput = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) handleFile(file);
      // Reset input so same file can be re-uploaded
      e.target.value = "";
    },
    [handleFile]
  );

  return (
    <>
      {/* Trigger */}
      <span onClick={handleTriggerClick} className="cursor-pointer">
        {children}
      </span>

      {/* No-client alert */}
      <AlertDialog open={showNoClientAlert} onOpenChange={setShowNoClientAlert}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <AlertTriangle className="w-5 h-5 text-amber-500" />
              需要绑定客户档案
            </AlertDialogTitle>
            <AlertDialogDescription>
              若需使用该功能，请先前往「我的客户」页面创建或选择一个客户档案。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setShowNoClientAlert(false);
                navigate("/clients");
              }}
            >
              创建或选择客户档案
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Upload dialog */}
      <Dialog open={showUploadDialog} onOpenChange={setShowUploadDialog}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>上传搜索字词报告</DialogTitle>
            <DialogDescription>
              请上传从媒体后台导出的 CSV 格式搜索字词报告（仅支持 .csv 文件）
            </DialogDescription>
          </DialogHeader>

          <div
            className={`mt-4 border-2 border-dashed rounded-xl p-10 flex flex-col items-center gap-4 transition-colors cursor-pointer ${
              isDragging
                ? "border-primary bg-primary/5"
                : "border-border hover:border-primary/50 hover:bg-muted/30"
            }`}
            onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
            onDragLeave={() => setIsDragging(false)}
            onDrop={handleDrop}
            onClick={() => !isParsing && fileInputRef.current?.click()}
          >
            <input
              ref={fileInputRef}
              type="file"
              accept=".csv"
              className="hidden"
              onChange={handleFileInput}
            />

            {isParsing ? (
              <>
                <Loader2 className="w-10 h-10 text-primary animate-spin" />
                <p className="text-sm text-muted-foreground">正在解析文件...</p>
              </>
            ) : (
              <>
                <div className="w-14 h-14 rounded-full bg-primary/10 flex items-center justify-center">
                  {isDragging ? (
                    <FileText className="w-7 h-7 text-primary" />
                  ) : (
                    <Upload className="w-7 h-7 text-primary" />
                  )}
                </div>
                <div className="text-center">
                  <p className="text-sm font-medium text-foreground">
                    {isDragging ? "松开即可上传" : "拖拽文件到此处，或点击选择"}
                  </p>
                  <p className="text-xs text-muted-foreground mt-1">仅支持 .csv 格式</p>
                </div>
              </>
            )}
          </div>

          {error && (
            <div className="mt-3 flex items-start gap-2 text-sm text-destructive bg-destructive/10 rounded-lg p-3">
              <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          <div className="mt-3 text-xs text-muted-foreground space-y-1">
            <p>• 系统将自动过滤汇总行及已添加/已排除的词条</p>
            <p>• 剩余词条将按花费从高到低排序</p>
            <p>• 您可在下一步预览并手动剔除不需要分析的词条</p>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
