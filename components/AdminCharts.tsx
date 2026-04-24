'use client';

import {
  PieChart,
  Pie,
  Cell,
  Tooltip as PieTooltip,
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip as BarTooltip,
  Legend
} from 'recharts';

export function AdminCharts({ 
  genderData, 
  convertsData 
}: { 
  genderData: { name: string, value: number, color: string }[],
  convertsData: { month: string, count: number }[]
}) {
  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-5 mb-5">
      {/* Gender Distribution */}
      <div className="bg-[#F0E6D3] border border-[rgba(90,55,20,0.13)] rounded-2xl p-6 shadow-sm flex flex-col">
        <h4 style={{ fontFamily: "'Playfair Display', serif" }} className="text-lg font-bold text-[#1E1208] mb-4">Gender Distribution</h4>
        <div className="flex-1 w-full" style={{ minWidth: 0, minHeight: 250 }}>
          {genderData.every(d => d.value === 0) ? (
             <div className="h-[250px] flex items-center justify-center text-[13px] text-[#9A7E65]">No gender data available.</div>
          ) : (
            <ResponsiveContainer width="100%" height={250}>
              <PieChart>
                <Pie
                  data={genderData}
                  cx="50%"
                  cy="50%"
                  innerRadius={60}
                  outerRadius={80}
                  paddingAngle={5}
                  dataKey="value"
                >
                  {genderData.map((entry, index) => (
                    <Cell key={`cell-${index}`} fill={entry.color} />
                  ))}
                </Pie>
                <PieTooltip 
                  contentStyle={{ backgroundColor: '#F0E6D3', border: '1px solid rgba(90,55,20,0.13)', borderRadius: '8px', fontSize: '13px', fontWeight: 'bold' }} 
                  itemStyle={{ color: '#1E1208' }}
                />
                <Legend iconType="circle" wrapperStyle={{ fontSize: '12px', fontWeight: 'bold', color: '#9A7E65' }} />
              </PieChart>
            </ResponsiveContainer>
          )}
        </div>
      </div>

      {/* New Converts Statistics */}
      <div className="bg-[#F0E6D3] border border-[rgba(90,55,20,0.13)] rounded-2xl p-6 shadow-sm flex flex-col">
        <h4 style={{ fontFamily: "'Playfair Display', serif" }} className="text-lg font-bold text-[#1E1208] mb-4">New Converts (Last 6 Months)</h4>
        <div className="flex-1 w-full" style={{ minWidth: 0, minHeight: 250 }}>
          {convertsData.every(d => d.count === 0) ? (
             <div className="h-[250px] flex items-center justify-center text-[13px] text-[#9A7E65]">No new converts over this period.</div>
          ) : (
            <ResponsiveContainer width="100%" height={250}>
              <BarChart data={convertsData} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                <XAxis dataKey="month" axisLine={false} tickLine={false} tick={{ fontSize: 12, fill: '#9A7E65', fontWeight: 'bold' }} />
                <YAxis axisLine={false} tickLine={false} tick={{ fontSize: 12, fill: '#9A7E65', fontWeight: 'bold' }} />
                <BarTooltip 
                  cursor={{ fill: 'rgba(90,55,20,0.05)' }}
                  contentStyle={{ backgroundColor: '#F0E6D3', border: '1px solid rgba(90,55,20,0.13)', borderRadius: '8px', fontSize: '13px', fontWeight: 'bold' }}
                />
                <Bar dataKey="count" fill="#B5622A" radius={[4, 4, 0, 0]} maxBarSize={40} name="New Converts" />
              </BarChart>
            </ResponsiveContainer>
          )}
        </div>
      </div>
    </div>
  );
}
