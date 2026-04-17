'use client';

import {
  Building2, Package, Shield, HelpCircle, Plus, Edit3, Trash2,
  Save, X, Upload, FileText, Globe, Eye, ChevronDown, ChevronRight,
  AlertTriangle, CheckCircle, Loader2, RefreshCw
} from 'lucide-react';
import { useState, useEffect, useCallback } from 'react';
import {
  knowledgeApi,
  type CompanyInfo,
  type Product,
  type PolicyRule,
  type FAQ,
  type KnowledgeDocument,
} from '@/lib/api';

/* ââ Tabs Config ââââââââââââââââââââââââââââââââââââââ */

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

  /* ââ Data Loading ââââââââââââââââââââââââââââââââââââââ $.ÈØ]YÛÜN	ÝØ\[IË]N	ÕØ\[HÛXÞIËÛÛ[Ø\[QYÛÛ[JNÂÙ]Ø\[Y\ÊØÜX]YJNÂBËÈ\Ù\[[Ú[È\\ÂY
[[Ú[ÖÌJHÂÛÛÝ\]YH]ØZ]ÛÝÛYÙP\K\]TÛXÞJÈY[[Ú[ÖÌKYÛÛ[[[Ú[ÑYÛÛ[JNÂÙ][[Ú[ÊÝ\]YJNÂH[ÙHY
[[Ú[ÑYÛÛ[[J
JHÂÛÛÝÜX]YH]ØZ]ÛÝÛYÙP\KÜX]TÛXÞJÈØ]YÛÜN	Ù[[Ú[ÉË]N	Ñ[[Ú[È\\ÉËÛÛ[[[Ú[ÑYÛÛ[JNÂÙ][[Ú[ÊØÜX]YJNÂBÙ]Y][ÕØ\[Y\Ê[ÙJNÂÚÝÕØ\Ý
	ÔÛXÚY\ÈØ]Y	ÊNÂHØ]Ú
JHÂÚÝÕØ\Ý
	ÑZ[YÈØ]HÛXÚY\ÉË	Ù\ÜÊNÂBÙ]Ø][Ê[ÙJNÂNÂÛÛÝØ[Ù[Ø\[Y\ÑY]H

HOÂÙ]Y][ÕØ\[Y\Ê[ÙJNÂÙ]]Ô[J	ÉÊNÂNÂÛÛÝY[HH\Þ[È

HOÂY
[]Ô[K[J
JH]\ÂÙ]Ø][ÊYJNÂHÂÛÛÝÜX]YH]ØZ]ÛÝÛYÙP\KÜX]TÛXÞJÂØ]YÛÜN	Ü[IË]N]Ô[K[J
KÛÛ[]Ô[K[J
KÛÜÜ\[\Ë[ÝJNÂÙ][\ÊË[\ËÜX]YJNÂÙ]]Ô[J	ÉÊNÂÚÝÕØ\Ý
	Ô[HYY	ÊNÂHØ]Ú
JHÂÚÝÕØ\Ý
	ÑZ[YÈY[IË	Ù\ÜÊNÂBÙ]Ø][Ê[ÙJNÂNÂÛÛÝ[[ÝT[HH\Þ[È
YÝ[ÊHOÂÙ]Ø][ÊYJNÂHÂ]ØZ]ÛÝÛYÙP\K[]TÛXÞJY
NÂÙ][\Ê[\Ë[\OYOOHY
JNÂÚÝÕØ\Ý
	Ô[H[[ÝY	ÊNÂHØ]Ú
JHÂÚÝÕØ\Ý
	ÑZ[YÈ[[ÝH[IË	Ù\ÜÊNÂBÙ]Ø][Ê[ÙJNÂNÂÊ8¥ 8¥ TH[\È8¥ 8¥ 8¥ 8¥ 8¥ 8¥ 8¥ 8¥ 8¥ 8¥ 8¥ 8¥ 8¥ 8¥ 8¥ 8¥ 8¥ 8¥ 8¥ 8¥ 8¥ 8¥ 8¥ 8¥ 8¥ 8¥ 8¥ 8¥ 8¥ 8¥ 8¥ 8¥ 8¥ 8¥ 8¥ 8¥ 8¥ 8¥ 
ÂÛÛÝØ]Q\HH\Þ[È

HOÂY
Y\QY]Y\Ý[Û[J
HY\QY[ÝÙ\[J
JH]\ÂÙ]Ø][ÊYJNÂHÂY
Y][Ñ\JHÂÛÛÝ\]YH]ØZ]ÛÝÛYÙP\K\]QTJÂYY][Ñ\K]Y\Ý[Û\QY]Y\Ý[Û[ÝÙ\\QY[ÝÙ\JNÂÙ]\\Ê\\ËX\
OYOOHY][Ñ\HÈ\]YJNÂÙ]Y][Ñ\J[
NÂÚÝÕØ\Ý
	ÑTH\]Y	ÊNÂH[ÙHÂÛÛÝÜX]YH]ØZ]ÛÝÛYÙP\KÜX]QTJÂ]Y\Ý[Û\QY]Y\Ý[Û[ÝÙ\\QY[ÝÙ\ÛÜÜ\\\Ë[ÝJNÂÙ]\\ÊË\\ËÜX]YJNÂÙ]ÚÝÐY\J[ÙJNÂÚÝÕØ\Ý
	ÑTHÜX]Y	ÊNÂBÙ]\QY
È]Y\Ý[Û	ÉË[ÝÙ\	ÉÈJNÂHØ]Ú
JHÂÚÝÕØ\Ý
	ÑZ[YÈØ]HTIË	Ù\ÜÊNÂBÙ]Ø][Ê[ÙJNÂNÂÛÛÝÝ\Y]\HH
TJHOÂÙ]\QY
È]Y\Ý[Û]Y\Ý[Û[ÝÙ\[ÝÙ\JNÂÙ]Y][Ñ\JY
NÂÙ]ÚÝÐY\J[ÙJNÂNÂÛÛÝ[]Q\HH\Þ[È
YÝ[ÊHOÂÙ]Ø][ÊYJNÂHÂ]ØZ]ÛÝÛYÙP\K[]QTJY
NÂÙ]\\Ê\\Ë[\OYOOHY
JNÂY
Y][Ñ\HOOHY
HÂÙ]Y][Ñ\J[
NÂÙ]\QY
È]Y\Ý[Û	ÉË[ÝÙ\	ÉÈJNÂBÚÝÕØ\Ý
	ÑTH[]Y	ÊNÂHØ]Ú
JHÂÚÝÕØ\Ý
	ÑZ[YÈ[]HTIË	Ù\ÜÊNÂBÙ]Ø][Ê[ÙJNÂNÂÛÛÝØ[Ù[\QY]H

HOÂÙ]Y][Ñ\J[
NÂÙ]ÚÝÐY\J[ÙJNÂÙ]\QY
È]Y\Ý[Û	ÉË[ÝÙ\	ÉÈJNÂNÂÊ8¥ 8¥ ØY[ÈØÜY[8¥ 8¥ 8¥ 8¥ 8¥ 8¥ 8¥ 8¥ 8¥ 8¥ 8¥ 8¥ 8¥ 8¥ 8¥ 8¥ 8¥ 8¥ 8¥ 8¥ 8¥ 8¥ 8¥ 8¥ 8¥ 8¥ 8¥ 8¥ 8¥ 8¥ 8¥ 8¥ 8¥ 8¥ 8¥ 8¥ 
ÂY
ØY[ÊHÂ]\
]Û\ÜÓ[YOH^][\ËXÙ[\\ÝYKXÙ[\Z[ZVÍH]Û\ÜÓ[YOH^^XÛÛ][\ËXÙ[\Ø\LÈØY\Û\ÜÓ[YOHËNN^Z[YÛËML[[X]K\Ü[ÏÛ\ÜÓ[YOH^\ÛH^YÜ^KMLØY[ÈÛÝÛYÙHÙ[\ÜÙ]Ù]
NÂBÊ8¥ 8¥ [\8¥ 8¥ 8¥ 8¥ 8¥ 8¥ 8¥ 8¥ 8¥ 8¥ 8¥ 8¥ 8¥ 8¥ 8¥ 8¥ 8¥ 8¥ 8¥ 8¥ 8¥ 8¥ 8¥ 8¥ 8¥ 8¥ 8¥ 8¥ 8¥ 8¥ 8¥ 8¥ 8¥ 8¥ 8¥ 8¥ 8¥ 8¥ 8¥ 8¥ 8¥ 8¥ 8¥ 8¥ 	colors">
                <Upload className="w-4 h-4" /> Upload Document
              </button>
            </div>

            <div className="border-2 border-dashed border-gray-300 rounded-lg p-8 text-center mb-6 hover:border-indigo-400 transition-colors cursor-pointer">
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

      {/* ââââââââââââââââââââââââââââââââââââââââââââââââââ $/}
      {/* TAB 2 â Products                                   */}
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
                        <h3 className="text-sm font-semibold text-gray-900">{@.name}</h3>
                        {p.category && <span className="text-xs bg-gray-100 text-gray-600 px-2 py-0.5 rounded-full">{p.category}</span>}
                        {p.price && <span className="text-xs font-semibold text-indigo-600">{@.price}</span>}
                       </div>
                        {@.description && <p className="text-sm text-gray-500">{@.description}</p>}
                        {@.sku && <p className="text-xs text-gray-400 mt-1">SKU: {@.sku}</p>}
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

      {/* ââââââââââââââââââââââââââââââââââââââââââââââââââ $/}
      {/* TAB 3 â Warranties & Financing                    */}
      {/* ââââââââââââââââââââââââââââââââââââââââââââââââââ $/}
      {(activeTab === 'warranties') && (
        <div className="space-y-6">
          <div className="bg-white border border-gray-200 rounded-xl p-6">
            <div className="flex items-center justify-between mb-6">
              <div>
                <h2 className="text-lg font-semibold text-gray-900">Warranties & Financing</h2>
                <p className="text-sm text-gray-500 mt-1">Define guardrails for how the AI discusses warranty policies, refunds, and financing options</p>
              </div>
              {!editingWarranties ? (
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

      {/* ââââââââââââââââââââââââââââââââââââââââââââââââââ $/}
      {/* TAB 4 â FAQ                                        */}
      {/* ââââââââââââââââââââââââââââââââââââââââââââââââââ */}
      {activeTab === 'faq' && (
        <div className="space-y-6">
          <div className="bg-white border border-gray-200 rounded-xl p-6">
            <div className="flex items-center justify-between mb-6">
              <div>
                <h2 className="text-lg font-semibold text-gray-900">Frequently Asked Questions</h2>
                <p className="text-sm text-gray-500 mt-1">Provide Q&A pairs the AI uses to answer customer,questions accurately</p>
              </div>
              {!showAddFaq && editingFaq === null && (
                <button onClick={() => { setShowAddFaq(true); setFaqDraft({ question: '', answer: '' }); }} className="flex items-center gap-2 px-4 py-2 bg-indigo-600 text-white text-sm font-medium rounded-lg hover:bg-indigo-700 transition-colors">
                  <Plus className="w-4 h-4" /> Add FAQ
                </button>
              )}
            </div>

            #{(showAddFaq || editingFaq !== null) && (
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
  
