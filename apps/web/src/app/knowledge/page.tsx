'use client';

import {
  Building2, Package, Shield, HelpCircle, Plus, Edit3, Trash2,
  Save, X, Upload, FileText, Globe, Eye, ChevronDown, ChevronRight,
  AlertTriangle, CheckCircle, Loader2, RefreshCw
} from 'lucide-react';
import { useState, useEffect, useCallback, useRef } from 'react';
import {
  knowledgeApi,
  type CompanyInfo,
  type Product,
  type PolicyRule,
  type FAQ,
  type KnowledgeDocument,
} from '@/lib/api';

/* ââ Tabs Config ââââââââââââââââââââââââââââââââââââââââ */

const tabs = [
  { id: 'company-truth', label: 'Company Truth', icon: Building2 },
  { id: 'products', label: 'Products', icon: Package },
  { id: 'warranties', label: 'Warranties & Financing', icon: Shield },
  { id: 'faq', label: 'FAQ', icon: HelpCircle },
];

/* ââ Toast Component ââââââââââââââââââââââââââââââââââââ */

function Toast({ message, type, onClose }: { message: string; type: 'success' | 'error'; onClose: () => void }) {
  useEffect(() => {
    const timer = setTimeout(onClose, 3000);
    return () => clearTimeout(timer);
  }, [onClose]);

  return (
    <div className={`fixed bottom-6 right-6 z-50 flex items-center gap-2 px-4 py-3 rounded-lg shadow-lg text-sm font-medium transition-all ${
      type === 'success' ? 'bg-emerald-600 text-white' : 'bg-red-600 text-white'
    }`}>
      {type === 'success' ? <CheckCircle className="w-4 h-4" /> : <AlertTriangle className="w-4 h-4" />}
      {message}
    </div>
  );
}

/* ââ Main Component ââââââââââââââââââââââââââââââââââââ */

export default function KnowledgeCenterPage() {
  const [activeTab, setActiveTab] = useState('company-truth');
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null);
  const showToast = (message: string, type: 'success' | 'error' = 'success') => setToast({ message, type });

  // ââ Loading states ââ
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  // ââ Company Truth state ââ
  const [companyInfo, setCompanyInfo] = useState<CompanyInfo | null>(null);
  const [editingCompany, setEditingCompany] = useState(false);
  const [companyDraft, setCompanyDraft] = useState({ vision: '', mission: '', websiteUrl: '' });
  const [documents, setDocuments] = useState<KnowledgeDocument[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // File upload constants
  const ALLOWED_TYPES = ['application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'text/plain', 'text/csv'];
  const ALLOWED_EXTENSIONS = ['.pdf', '.docx', '.xlsx', '.txt', '.csv'];
  const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB

  const handleFiles = async (files: FileList | File[]) => {
    const fileArray = Array.from(files);
    setIsUploading(true);
    let successCount = 0;
    let errorMessages: string[] = [];

    for (const file of fileArray) {
      // Validate file type
      const ext = '.' + file.name.split('.').pop()?.toLowerCase();
      if (!ALLOWED_TYPES.includes(file.type) && !ALLOWED_EXTENSIONS.includes(ext)) {
        errorMessages.push(`${file.name}: unsupported file type`);
        continue;
      }
      // Validate file size
      if (file.size > MAX_FILE_SIZE) {
        errorMessages.push(`${file.name}: exceeds 10MB limit`);
        continue;
      }
      try {
        const doc = await knowledgeApi.createDocument({
          name: file.name,
          type: file.type || ext,
          sizeBytes: file.size,
        });
        setDocuments(prev => [...prev, doc]);
        successCount++;
      } catch (err) {
        errorMessages.push(`${file.name}: upload failed`);
      }
    }

    setIsUploading(false);
    if (successCount > 0) {
      showToast(`${successCount} document${successCount > 1 ? 's' : ''} uploaded`, 'success');
    }
    if (errorMessages.length > 0) {
      showToast(errorMessages.join(', '), 'error');
    }
    // Reset file input
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
    if (e.dataTransfer.files.length > 0) {
      handleFiles(e.dataTransfer.files);
    }
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
  };

  // ââ Products state ââ
  const [products, setProducts] = useState<Product[]>([]);
  const [editingProduct, setEditingProduct] = useState<string | null>(null);
  const [showAddProduct, setShowAddProduct] = useState(false);
  const [productDraft, setProductDraft] = useState({ name: '', category: '', price: '', description: '', sku: '' });

  // ââ Policies state (Warranties & Financing) ââ
  const [warranties, setWarranties] = useState<PolicyRule[]>([]);
  const [financing, setFinancing] = useState<PolicyRule[]>([]);
  const [rules, setRules] = useState<PolicyRule[]>([]);
  const [editingWarranties, setEditingWarranties] = useState(false);
  const [warrantyDraft, setWarrantyDraft] = useState({ title: '', content: '' });
  const [financingDraft, setFinancingDraft] = useState({ title: '', content: '' });
  const [newRule, setNewRule] = useState('');

  // ââ FAQ state ââ
  const [faqs, setFaqs] = useState<FAQ[]>([]);
  const [editingFaq, setEditingFaq] = useState<string | null>(null);
  const [showAddFaq, setShowAddFaq] = useState(false);
  const [faqDraft, setFaqDraft] = useState({ question: '', answer: '' });
  const [expandedFaq, setExpandedFaq] = useState<string | null>(null);

  /* ââ Data Loading ââââââââââââââââââââââââââââââââââââââ */

  const loadCompanyData = useCallback(async () => {
    try {
      const [info, docs] = await Promise.all([
        knowledgeApi.getCompanyInfo(),
        knowledgeApi.listDocuments({ limit: 50 }),
      ]);
      setCompanyInfo(info);
      setDocuments(docs.documents);
    } catch (e) {
      console.error('Failed to load company data:', e);
      showToast('Failed to load company data', 'error');
    }
  }, []);

  const loadProducts = useCallback(async () => {
    try {
      const res = await knowledgeApi.listProducts({ limit: 100 });
      setProducts(res.products);
    } catch (e) {
      console.error('Failed to load products:', e);
      showToast('Failed to load products', 'error');
    }
  }, []);

  const loadPolicies = useCallback(async () => {
    try {
      const [w, f, r] = await Promise.all([
        knowledgeApi.listPolicies({ category: 'warranty', limit: 50 }),
        knowledgeApi.listPolicies({ category: 'financing', limit: 50 }),
        knowledgeApi.listPolicies({ category: 'rule', limit: 50 }),
      ]);
      setWarranties(w.policies);
      setFinancing(f.policies);
      setRules(r.policies);
    } catch (e) {
      console.error('Failed to load policies:', e);
      showToast('Failed to load policies', 'error');
    }
  }, []);

  const loadFAQs = useCallback(async () => {
    try {
      const res = await knowledgeApi.listFAQs({ limit: 100 });
      setFaqs(res.faqs);
    } catch (e) {
      console.error('Failed to load FAQs:', e);
      showToast('Failed to load FAQs', 'error');
    }
  }, []);

  // Initial load
  useEffect(() => {
    const loadAll = async () => {
      setLoading(true);
      await Promise.all([loadCompanyData(), loadProducts(), loadPolicies(), loadFAQs()]);
      setLoading(false);
    };
    loadAll();
  }, [loadCompanyData, loadProducts, loadPolicies, loadFAQs]);

  /* ââ Company Truth Handlers ââââââââââââââââââââââââââââ */

  const saveCompanyInfo = async () => {
    setSaving(true);
    try {
      const updated = await knowledgeApi.updateCompanyInfo({
        vision: companyDraft.vision,
        mission: companyDraft.mission,
        websiteUrl: companyDraft.websiteUrl || null,
      });
      setCompanyInfo(updated);
      setEditingCompany(false);
      showToast('Company info saved');
    } catch (e) {
      showToast('Failed to save company info', 'error');
    }
    setSaving(false);
  };

  const cancelCompanyEdit = () => {
    setCompanyDraft({
      vision: companyInfo?.vision || '',
      mission: companyInfo?.mission || '',
      websiteUrl: companyInfo?.websiteUrl || '',
    });
    setEditingCompany(false);
  };

  const startCompanyEdit = () => {
    setCompanyDraft({
      vision: companyInfo?.vision || '',
      mission: companyInfo?.mission || '',
      websiteUrl: companyInfo?.websiteUrl || '',
    });
    setEditingCompany(true);
  };

  const removeDocument = async (id: string) => {
    setSaving(true);
    try {
      await knowledgeApi.deleteDocument(id);
      setDocuments(documents.filter(d => d.id !== id));
      showToast('Document removed');
    } catch (e) {
      showToast('Failed to remove document', 'error');
    }
    setSaving(false);
  };

  /* ââ Product Handlers ââââââââââââââââââââââââââââââââââ */

  const saveProduct = async () => {
    if (!productDraft.name.trim()) return;
    setSaving(true);
    try {
      if (editingProduct) {
        const updated = await knowledgeApi.updateProduct({
          id: editingProduct,
          name: productDraft.name,
          category: productDraft.category || undefined,
          price: productDraft.price || undefined,
          description: productDraft.description || undefined,
          sku: productDraft.sku || undefined,
        });
        setProducts(products.map(p => p.id === editingProduct ? updated : p));
        setEditingProduct(null);
        showToast('Product updated');
      } else {
        const created = await knowledgeApi.createProduct({
          name: productDraft.name,
          category: productDraft.category || undefined,
          price: productDraft.price || undefined,
          description: productDraft.description || undefined,
          sku: productDraft.sku || undefined,
        });
        setProducts([...products, created]);
        setShowAddProduct(false);
        showToast('Product created');
      }
      setProductDraft({ name: '', category: '', price: '', description: '', sku: '' });
    } catch (e) {
      showToast('Failed to save product', 'error');
    }
    setSaving(false);
  };

  const startEditProduct = (p: Product) => {
    setProductDraft({
      name: p.name,
      category: p.category || '',
      price: p.price || '',
      description: p.description || '',
      sku: p.sku || '',
    });
    setEditingProduct(p.id);
    setShowAddProduct(false);
  };

  const deleteProduct = async (id: string) => {
    setSaving(true);
    try {
      await knowledgeApi.deleteProduct(id);
      setProducts(products.filter(p => p.id !== id));
      if (editingProduct === id) {
        setEditingProduct(null);
        setProductDraft({ name: '', category: '', price: '', description: '', sku: '' });
      }
      showToast('Product deleted');
    } catch (e) {
      showToast('Failed to delete product', 'error');
    }
    setSaving(false);
  };

  const cancelProductEdit = () => {
    setEditingProduct(null);
    setShowAddProduct(false);
    setProductDraft({ name: '', category: '', price: '', description: '', sku: '' });
  };

  /* ââ Warranties & Financing Handlers âââââââââââââââââââ */

  const startWarrantiesEdit = () => {
    setWarrantyDraft({
      title: 'Warranty Policy',
      content: warranties[0]?.content || '',
    });
    setFinancingDraft({
      title: 'Financing Terms',
      content: financing[0]?.content || '',
    });
    setEditingWarranties(true);
  };

  const saveWarranties = async () => {
    setSaving(true);
    try {
      // Upsert warranty policy
      if (warranties[0]) {
        const updated = await knowledgeApi.updatePolicy({ id: warranties[0].id, content: warrantyDraft.content });
        setWarranties([updated]);
      } else if (warrantyDraft.content.trim()) {
        const created = await knowledgeApi.createPolicy({ category: 'warranty', title: 'Warranty Policy', content: warrantyDraft.content });
        setWarranties([created]);
      }

      // Upsert financing terms
      if (financing[0]) {
        const updated = await knowledgeApi.updatePolicy({ id: financing[0].id, content: financingDraft.content });
        setFinancing([updated]);
      } else if (financingDraft.content.trim()) {
        const created = await knowledgeApi.createPolicy({ category: 'financing', title: 'Financing Terms', content: financingDraft.content });
        setFinancing([created]);
      }

      setEditingWarranties(false);
      showToast('Policies saved');
    } catch (e) {
      showToast('Failed to save policies', 'error');
    }
    setSaving(false);
  };

  const cancelWarrantiesEdit = () => {
    setEditingWarranties(false);
    setNewRule('');
  };

  const addRule = async () => {
    if (!newRule.trim()) return;
    setSaving(true);
    try {
      const created = await knowledgeApi.createPolicy({
        category: 'rule',
        title: newRule.trim(),
        content: newRule.trim(),
        sortOrder: rules.length,
      });
      setRules([...rules, created]);
      setNewRule('');
      showToast('Rule added');
    } catch (e) {
      showToast('Failed to add rule', 'error');
    }
    setSaving(false);
  };

  const removeRule = async (id: string) => {
    setSaving(true);
    try {
      await knowledgeApi.deletePolicy(id);
      setRules(rules.filter(r => r.id !== id));
      showToast('Rule removed');
    } catch (e) {
      showToast('Failed to remove rule', 'error');
    }
    setSaving(false);
  };

  /* ââ FAQ Handlers ââââââââââââââââââââââââââââââââââââââ */

  const saveFaq = async () => {
    if (!faqDraft.question.trim() || !faqDraft.answer.trim()) return;
    setSaving(true);
    try {
      if (editingFaq) {
        const updated = await knowledgeApi.updateFAQ({
          id: editingFaq,
          question: faqDraft.question,
          answer: faqDraft.answer,
        });
        setFaqs(faqs.map(f => f.id === editingFaq ? updated : f));
        setEditingFaq(null);
        showToast('FAQ updated');
      } else {
        const created = await knowledgeApi.createFAQ({
          question: faqDraft.question,
          answer: faqDraft.answer,
          sortOrder: faqs.length,
        });
        setFaqs([...faqs, created]);
        setShowAddFaq(false);
        showToast('FAQ created');
      }
      setFaqDraft({ question: '', answer: '' });
    } catch (e) {
      showToast('Failed to save FAQ', 'error');
    }
    setSaving(false);
  };

  const startEditFaq = (f: FAQ) => {
    setFaqDraft({ question: f.question, answer: f.answer });
    setEditingFaq(f.id);
    setShowAddFaq(false);
  };

  const deleteFaq = async (id: string) => {
    setSaving(true);
    try {
      await knowledgeApi.deleteFAQ(id);
      setFaqs(faqs.filter(f => f.id !== id));
      if (editingFaq === id) {
        setEditingFaq(null);
        setFaqDraft({ question: '', answer: '' });
      }
      showToast('FAQ deleted');
    } catch (e) {
      showToast('Failed to delete FAQ', 'error');
    }
    setSaving(false);
  };

  const cancelFaqEdit = () => {
    setEditingFaq(null);
    setShowAddFaq(false);
    setFaqDraft({ question: '', answer: '' });
  };

  /* ââ Loading Screen ââââââââââââââââââââââââââââââââââââ */

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <div className="flex flex-col items-center gap-3">
          <Loader2 className="w-8 h-8 text-indigo-500 animate-spin" />
          <p className="text-sm text-gray-500">Loading Knowledge Center...</p>
        </div>
      </div>
    );
  }

  /* ââ Render ââââââââââââââââââââââââââââââââââââââââââââ */
  return (
    <div className="p-6 space-y-6">
      {toast && <Toast message={toast.message} type={toast.type} onClose={() => setToast(null)} />}

      {/* Saving overlay indicator */}
      {saving && (
        <div className="fixed top-4 right-4 z-50 flex items-center gap-2 px-3 py-2 bg-white border border-gray-200 rounded-lg shadow-md text-sm text-gray-600">
          <Loader2 className="w-4 h-4 animate-spin text-indigo-500" />
          Saving...
        </div>
      )}

      {/* ââ Tab Bar ââ */}
      <div className="flex gap-1 bg-gray-100 p-1 rounded-lg w-fit">
        {tabs.map(t => {
          const Icon = t.icon;
          return (
            <button
              key={t.id}
              onClick={() => setActiveTab(t.id)}
              className={`flex items-center gap-2 px-4 py-2 rounded-md text-sm font-medium transition-all ${
                activeTab === t.id ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'
              }`}
            >
              <Icon className="w-4 h-4" />
              {t.label}
            </button>
          );
        })}
      </div>

      {/* ââââââââââââââââââââââââââââââââââââââââââââââââââ */}
      {/* TAB 1 â Company Truth                            */}
      {/* ââââââââââââââââââââââââââââââââââââââââââââââââââ */}
      {activeTab === 'company-truth' && (
        <div className="space-y-6">
          {/* Company Info Card */}
          <div className="bg-white border border-gray-200 rounded-xl p-6">
            <div className="flex items-center justify-between mb-6">
              <div>
                <h2 className="text-lg font-semibold text-gray-900">Company Information</h2>
                <p className="text-sm text-gray-500 mt-1">Core company details the AI uses for context in every interaction</p>
              </div>
              {!editingCompany ? (
                <button onClick={startCompanyEdit} className="flex items-center gap-2 px-4 py-2 bg-indigo-600 text-white text-sm font-medium rounded-lg hover:bg-indigo-700 transition-colors">
                  <Edit3 className="w-4 h-4" /> Edit
                </button>
              ) : (
                <div className="flex gap-2">
                  <button onClick={cancelCompanyEdit} className="flex items-center gap-2 px-4 py-2 border border-gray-300 text-gray-700 text-sm font-medium rounded-lg hover:bg-gray-50 transition-colors">
                    <X className="w-4 h-4" /> Cancel
                  </button>
                  <button onClick={saveCompanyInfo} disabled={saving} className="flex items-center gap-2 px-4 py-2 bg-indigo-600 text-white text-sm font-medium rounded-lg hover:bg-indigo-700 transition-colors disabled:opacity-50">
                    {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />} Save
                  </button>
                </div>
              )}
            </div>

            <div className="space-y-5">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Vision</label>
                {editingCompany ? (
                  <textarea value={companyDraft.vision} onChange={e => setCompanyDraft({ ...companyDraft, vision: e.target.value })} rows={3} className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none" />
                ) : (
                  <p className="text-sm text-gray-600 bg-gray-50 rounded-lg px-4 py-3">{companyInfo?.vision || 'Not set'}</p>
                )}
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Mission</label>
                {editingCompany ? (
                  <textarea value={companyDraft.mission} onChange={e => setCompanyDraft({ ...companyDraft, mission: e.target.value })} rows={3} className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none" />
                ) : (
                  <p className="text-sm text-gray-600 bg-gray-50 rounded-lg px-4 py-3">{companyInfo?.mission || 'Not set'}</p>
                )}
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Website URL</label>
                {editingCompany ? (
                  <div className="flex items-center gap-2">
                    <Globe className="w-4 h-4 text-gray-400" />
                    <input type="url" value={companyDraft.websiteUrl} onChange={e => setCompanyDraft({ ...companyDraft, websiteUrl: e.target.value })} className="flex-1 px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none" />
                  </div>
                ) : (
                  <div className="flex items-center gap-2 bg-gray-50 rounded-lg px-4 py-3">
                    <Globe className="w-4 h-4 text-indigo-500" />
                    {companyInfo?.websiteUrl ? (
                      <a href={companyInfo.websiteUrl} target="_blank" rel="noopener noreferrer" className="text-sm text-indigo-600 hover:underline">{companyInfo.websiteUrl}</a>
                    ) : (
                      <span className="text-sm text-gray-400">Not set</span>
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Documents Card */}
          <div className="bg-white border border-gray-200 rounded-xl p-6">
            <div className="flex items-center justify-between mb-6">
              <div>
                <h2 className="text-lg font-semibold text-gray-900">Reference Documents</h2>
                <p className="text-sm text-gray-500 mt-1">Upload documents the AI will use as additional context (brand guides, playbooks, pricing sheets)</p>
              </div>
              <button onClick={() => fileInputRef.current?.click()} disabled={isUploading} className="flex items-center gap-2 px-4 py-2 bg-indigo-600 text-white text-sm font-medium rounded-lg hover:bg-indigo-700 transition-colors disabled:opacity-50">
                <Upload className="w-4 h-4" /> {isUploading ? 'Uploading...' : 'Upload Document'}
              </button>
            </div>

            <input
              type="file"
              ref={fileInputRef}
              onChange={(e) => e.target.files && handleFiles(e.target.files)}
              multiple
              accept=".pdf,.docx,.xlsx,.txt,.csv"
              className="hidden"
            />
            <div
              onDrop={handleDrop}
              onDragOver={handleDragOver}
              onDragEnter={handleDragOver}
              onDragLeave={handleDragLeave}
              onClick={() => fileInputRef.current?.click()}
              className={`border-2 border-dashed rounded-lg p-8 text-center mb-6 transition-colors cursor-pointer ${
                isDragging ? 'border-indigo-500 bg-indigo-50' : 'border-gray-300 hover:border-indigo-400'
              }`}>
              <Upload className="w-8 h-8 text-gray-400 mx-auto mb-2" />
              <p className="text-sm text-gray-600 font-medium">Drag and drop files here, or click to browse</p>
              <p className="text-xs text-gray-400 mt-1">PDF, DOCX, XLSX, TXT â Max 10MB per file</p>
            </div>

            {documents.length > 0 && (
              <div className="space-y-2">
                {documents.map(doc => (
                  <div key={doc.id} className="flex items-center justify-between px-4 py-3 bg-gray-50 rounded-lg hover:bg-gray-100 transition-colors">
                    <div className="flex items-center gap-3">
                      <FileText className="w-5 h-5 text-indigo-500" />
                      <div>
                        <p className="text-sm font-medium text-gray-900">{doc.name}</p>
                        <p className="text-xs text-gray-400">{doc.type} Â· {(doc.sizeBytes / 1024).toFixed(0)} KB Â· Uploaded {new Date(doc.uploadedAt).toLocaleDateString()}</p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <button className="p-1.5 text-gray-400 hover:text-indigo-600 rounded-md hover:bg-white transition-colors"><Eye className="w-4 h-4" /></button>
                      <button onClick={() => removeDocument(doc.id)} className="p-1.5 text-gray-400 hover:text-red-600 rounded-md hover:bg-white transition-colors"><Trash2 className="w-4 h-4" /></button>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {documents.length === 0 && (
              <div className="text-center py-8 text-gray-400">
                <FileText className="w-10 h-10 mx-auto mb-3 opacity-50" />
                <p className="text-sm font-medium">No documents uploaded yet</p>
                <p className="text-xs mt-1">Upload reference documents for the AI to use</p>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ââââââââââââââââââââââââââââââââââââââââââââââââââ */}
      {/* TAB 2 â Products                                 */}
      {/* ââââââââââââââââââââââââââââââââââââââââââââââââââ */}
      {activeTab === 'products' && (
        <div className="space-y-6">
          <div className="bg-white border border-gray-200 rounded-xl p-6">
            <div className="flex items-center justify-between mb-6">
              <div>
                <h2 className="text-lg font-semibold text-gray-900">Products</h2>
                <p className="text-sm text-gray-500 mt-1">Manage your product catalog â the AI references these for pricing, descriptions, and recommendations</p>
              </div>
              {!showAddProduct && editingProduct === null && (
                <button onClick={() => { setShowAddProduct(true); setProductDraft({ name: '', category: '', price: '', description: '', sku: '' }); }} className="flex items-center gap-2 px-4 py-2 bg-indigo-600 text-white text-sm font-medium rounded-lg hover:bg-indigo-700 transition-colors">
                  <Plus className="w-4 h-4" /> Add Product
                </button>
              )}
            </div>

            {(showAddProduct || editingProduct !== null) && (
              <div className="border border-indigo-200 bg-indigo-50/50 rounded-xl p-5 mb-6">
                <h3 className="text-sm font-semibold text-gray-900 mb-4">{editingProduct !== null ? 'Edit Product' : 'New Product'}</h3>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">Product Name</label>
                    <input value={productDraft.name} onChange={e => setProductDraft({ ...productDraft, name: e.target.value })} className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none" placeholder="e.g. Growth Suite Pro" />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">Category</label>
                    <input value={productDraft.category} onChange={e => setProductDraft({ ...productDraft, category: e.target.value })} className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none" placeholder="e.g. SaaS Platform" />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">Price</label>
                    <input value={productDraft.price} onChange={e => setProductDraft({ ...productDraft, price: e.target.value })} className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none" placeholder="e.g. $299/mo" />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">SKU</label>
                    <input value={productDraft.sku} onChange={e => setProductDraft({ ...productDraft, sku: e.target.value })} className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none" placeholder="e.g. GSP-001" />
                  </div>
                  <div className="md:col-span-2">
                    <label className="block text-xs font-medium text-gray-600 mb-1">Description</label>
                    <textarea value={productDraft.description} onChange={e => setProductDraft({ ...productDraft, description: e.target.value })} rows={3} className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none" placeholder="Describe the product for the AI..." />
                  </div>
                </div>
                <div className="flex justify-end gap-2 mt-4">
                  <button onClick={cancelProductEdit} className="px-4 py-2 border border-gray-300 text-gray-700 text-sm font-medium rounded-lg hover:bg-gray-50 transition-colors">Cancel</button>
                  <button onClick={saveProduct} disabled={!productDraft.name.trim() || saving} className="px-4 py-2 bg-indigo-600 text-white text-sm font-medium rounded-lg hover:bg-indigo-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed">
                    <span className="flex items-center gap-2">
                      {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                      {editingProduct !== null ? 'Update' : 'Save'}
                    </span>
                  </button>
                </div>
              </div>
            )}

            <div className="space-y-3">
              {products.map(p => (
                <div key={p.id} className={`border rounded-xl p-4 transition-colors ${editingProduct === p.id ? 'border-indigo-300 bg-indigo-50/30' : 'border-gray-200 hover:border-gray-300'}`}>
                  <div className="flex items-start justify-between">
                    <div className="flex-1">
                      <div className="flex items-center gap-3 mb-1">
                        <h3 className="text-sm font-semibold text-gray-900">{p.name}</h3>
                        {p.category && <span className="text-xs bg-gray-100 text-gray-600 px-2 py-0.5 rounded-full">{p.category}</span>}
                        {p.price && <span className="text-xs font-semibold text-indigo-600">{p.price}</span>}
                      </div>
                      {p.description && <p className="text-sm text-gray-500">{p.description}</p>}
                      {p.sku && <p className="text-xs text-gray-400 mt-1">SKU: {p.sku}</p>}
                    </div>
                    <div className="flex items-center gap-1 ml-4">
                      <button onClick={() => startEditProduct(p)} className="p-1.5 text-gray-400 hover:text-indigo-600 rounded-md hover:bg-gray-100 transition-colors"><Edit3 className="w-4 h-4" /></button>
                      <button onClick={() => deleteProduct(p.id)} className="p-1.5 text-gray-400 hover:text-red-600 rounded-md hover:bg-gray-100 transition-colors"><Trash2 className="w-4 h-4" /></button>
                    </div>
                  </div>
                </div>
              ))}
              {products.length === 0 && (
                <div className="text-center py-12 text-gray-400">
                  <Package className="w-10 h-10 mx-auto mb-3 opacity-50" />
                  <p className="text-sm font-medium">No products yet</p>
                  <p className="text-xs mt-1">Click &quot;Add Product&quot; to create your first product</p>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ââââââââââââââââââââââââââââââââââââââââââââââââââ */}
      {/* TAB 3 â Warranties & Financing                   */}
      {/* ââââââââââââââââââââââââââââââââââââââââââââââââââ */}
      {activeTab === 'warranties' && (
        <div className="space-y-6">
          <div className="bg-white border border-gray-200 rounded-xl p-6">
            <div className="flex items-center justify-between mb-6">
              <div>
                <h2 className="text-lg font-semibold text-gray-900">Warranties & Financing</h2>
                <p className="text-sm text-gray-500 mt-1">Define guardrails for how the AI discusses warranty policies, refunds, and financing options</p>
              </div>
              {!editingWarranties ? (
                <button onClick={startWarrantiesEdit} className="flex items-center gap-2 px-4 py-2 bg-indigo-600 text-white text-sm font-medium rounded-lg hover:bg-indigo-700 transition-colors">
                  <Edit3 className="w-4 h-4" /> Edit
                </button>
              ) : (
                <div className="flex gap-2">
                  <button onClick={cancelWarrantiesEdit} className="flex items-center gap-2 px-4 py-2 border border-gray-300 text-gray-700 text-sm font-medium rounded-lg hover:bg-gray-50 transition-colors">
                    <X className="w-4 h-4" /> Cancel
                  </button>
                  <button onClick={saveWarranties} disabled={saving} className="flex items-center gap-2 px-4 py-2 bg-indigo-600 text-white text-sm font-medium rounded-lg hover:bg-indigo-700 transition-colors disabled:opacity-50">
                    {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />} Save
                  </button>
                </div>
              )}
            </div>

            <div className="space-y-6">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Warranty Policy</label>
                {editingWarranties ? (
                  <textarea value={warrantyDraft.content} onChange={e => setWarrantyDraft({ ...warrantyDraft, content: e.target.value })} rows={4} className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none" />
                ) : (
                  <p className="text-sm text-gray-600 bg-gray-50 rounded-lg px-4 py-3">{warranties[0]?.content || 'Not set â click Edit to define your warranty policy'}</p>
                )}
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Financing Terms</label>
                {editingWarranties ? (
                  <textarea value={financingDraft.content} onChange={e => setFinancingDraft({ ...financingDraft, content: e.target.value })} rows={4} className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none" />
                ) : (
                  <p className="text-sm text-gray-600 bg-gray-50 rounded-lg px-4 py-3">{financing[0]?.content || 'Not set â click Edit to define your financing terms'}</p>
                )}
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">AI Guardrail Rules</label>
                <p className="text-xs text-gray-400 mb-3">The AI will strictly follow these rules when discussing warranties and financing</p>

                <div className="space-y-2">
                  {rules.map(rule => (
                    <div key={rule.id} className="flex items-center gap-3 px-4 py-2.5 bg-amber-50 border border-amber-200 rounded-lg">
                      <AlertTriangle className="w-4 h-4 text-amber-500 flex-shrink-0" />
                      <span className="text-sm text-gray-700 flex-1">{rule.content}</span>
                      {editingWarranties && (
                        <button onClick={() => removeRule(rule.id)} className="p-1 text-gray-400 hover:text-red-500 transition-colors"><X className="w-4 h-4" /></button>
                      )}
                    </div>
                  ))}
                </div>

                {editingWarranties && (
                  <div className="flex gap-2 mt-3">
                    <input value={newRule} onChange={e => setNewRule(e.target.value)} onKeyDown={e => e.key === 'Enter' && addRule()} placeholder="Add a new guardrail rule..." className="flex-1 px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none" />
                    <button onClick={addRule} disabled={!newRule.trim() || saving} className="px-4 py-2 bg-amber-500 text-white text-sm font-medium rounded-lg hover:bg-amber-600 transition-colors disabled:opacity-50 disabled:cursor-not-allowed">
                      <Plus className="w-4 h-4" />
                    </button>
                  </div>
                )}

                {rules.length === 0 && !editingWarranties && (
                  <div className="text-center py-6 text-gray-400">
                    <AlertTriangle className="w-8 h-8 mx-auto mb-2 opacity-50" />
                    <p className="text-sm">No guardrail rules defined yet</p>
                    <p className="text-xs mt-1">Click Edit to add rules the AI must follow</p>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ââââââââââââââââââââââââââââââââââââââââââââââââââ */}
      {/* TAB 4 â FAQ                                      */}
      {/* ââââââââââââââââââââââââââââââââââââââââââââââââââ */}
      {activeTab === 'faq' && (
        <div className="space-y-6">
          <div className="bg-white border border-gray-200 rounded-xl p-6">
            <div className="flex items-center justify-between mb-6">
              <div>
                <h2 className="text-lg font-semibold text-gray-900">Frequently Asked Questions</h2>
                <p className="text-sm text-gray-500 mt-1">Provide Q&A pairs the AI uses to answer customer questions accurately</p>
              </div>
              {!showAddFaq && editingFaq === null && (
                <button onClick={() => { setShowAddFaq(true); setFaqDraft({ question: '', answer: '' }); }} className="flex items-center gap-2 px-4 py-2 bg-indigo-600 text-white text-sm font-medium rounded-lg hover:bg-indigo-700 transition-colors">
                  <Plus className="w-4 h-4" /> Add FAQ
                </button>
              )}
            </div>

            {(showAddFaq || editingFaq !== null) && (
              <div className="border border-indigo-200 bg-indigo-50/50 rounded-xl p-5 mb-6">
                <h3 className="text-sm font-semibold text-gray-900 mb-4">{editingFaq !== null ? 'Edit FAQ' : 'New FAQ'}</h3>
                <div className="space-y-4">
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">Question</label>
                    <input value={faqDraft.question} onChange={e => setFaqDraft({ ...faqDraft, question: e.target.value })} className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none" placeholder="e.g. What is the difference between plans?" />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">Answer</label>
                    <textarea value={faqDraft.answer} onChange={e => setFaqDraft({ ...faqDraft, answer: e.target.value })} rows={4} className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none" placeholder="Provide the answer the AI should give..." />
                  </div>
                </div>
                <div className="flex justify-end gap-2 mt-4">
                  <button onClick={cancelFaqEdit} className="px-4 py-2 border border-gray-300 text-gray-700 text-sm font-medium rounded-lg hover:bg-gray-50 transition-colors">Cancel</button>
                  <button onClick={saveFaq} disabled={!faqDraft.question.trim() || !faqDraft.answer.trim() || saving} className="px-4 py-2 bg-indigo-600 text-white text-sm font-medium rounded-lg hover:bg-indigo-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed">
                    <span className="flex items-center gap-2">
                      {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                      {editingFaq !== null ? 'Update' : 'Save'}
                    </span>
                  </button>
                </div>
              </div>
            )}

            <div className="space-y-2">
              {faqs.map(f => (
                <div key={f.id} className="border border-gray-200 rounded-xl overflow-hidden transition-colors hover:border-gray-300">
                  <div className="flex items-center justify-between px-4 py-3 cursor-pointer" onClick={() => setExpandedFaq(expandedFaq === f.id ? null : f.id)}>
                    <div className="flex items-center gap-3 flex-1">
                      {expandedFaq === f.id ? <ChevronDown className="w-4 h-4 text-gray-400" /> : <ChevronRight className="w-4 h-4 text-gray-400" />}
                      <span className="text-sm font-medium text-gray-900">{f.question}</span>
                    </div>
                    <div className="flex items-center gap-1 ml-4" onClick={e => e.stopPropagation()}>
                      <button onClick={() => startEditFaq(f)} className="p-1.5 text-gray-400 hover:text-indigo-600 rounded-md hover:bg-gray-100 transition-colors"><Edit3 className="w-4 h-4" /></button>
                      <button onClick={() => deleteFaq(f.id)} className="p-1.5 text-gray-400 hover:text-red-600 rounded-md hover:bg-gray-100 transition-colors"><Trash2 className="w-4 h-4" /></button>
                    </div>
                  </div>
                  {expandedFaq === f.id && (
                    <div className="px-4 pb-4 pt-0 ml-7">
                      <p className="text-sm text-gray-600 bg-gray-50 rounded-lg px-4 py-3">{f.answer}</p>
                    </div>
                  )}
                </div>
              ))}
              {faqs.length === 0 && (
                <div className="text-center py-12 text-gray-400">
                  <HelpCircle className="w-10 h-10 mx-auto mb-3 opacity-50" />
                  <p className="text-sm font-medium">No FAQs yet</p>
                  <p className="text-xs mt-1">Click &quot;Add FAQ&quot; to create your first question and answer</p>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
