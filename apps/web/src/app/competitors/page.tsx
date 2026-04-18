"use client";
export default function CompetitorsPage() {
  return (
    <div className="p-8">
      <h1 className="text-2xl font-bold mb-4">Competitor Intelligence</h1>
      <p className="text-gray-600 mb-6">Track and analyze your competitive landscape.</p>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-8">
        <div className="bg-white rounded-lg shadow p-6">
          <h3 className="text-sm text-gray-500">Total Competitors</h3>
          <p className="text-3xl font-bold">0</p>
        </div>
        <div className="bg-white rounded-lg shadow p-6">
          <h3 className="text-sm text-gray-500">Active Tracking</h3>
          <p className="text-3xl font-bold">0</p>
        </div>
        <div className="bg-white rounded-lg shadow p-6">
          <h3 className="text-sm text-gray-500">News Items</h3>
          <p className="text-3xl font-bold">0</p>
        </div>
      </div>
      <div className="bg-white rounded-lg shadow p-6">
        <p className="text-gray-500">Add competitors to start tracking.</p>
      </div>
    </div>
  );
}
