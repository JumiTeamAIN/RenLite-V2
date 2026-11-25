import React from 'react';

export const LandingPage: React.FC = () => {
  return (
    <div className="min-h-screen bg-slate-50 flex flex-col font-sans">
      {/* Header */}
      <header className="bg-white border-b border-gray-200 py-4 shadow-sm">
        <div className="flex items-center justify-center gap-2">
          <div className="w-6 h-6 bg-indigo-600 rounded flex items-center justify-center text-white text-xs font-bold">R</div>
          <h1 className="text-gray-900 font-bold tracking-tight">Welcome to Ren Spaces</h1>
        </div>
      </header>

      {/* Main Content */}
      <main className="flex-1 flex items-center justify-center p-4">
        <div className="bg-white rounded-xl shadow-xl max-w-4xl w-full p-10 text-center border border-gray-100">
          
          <h2 className="text-3xl font-bold text-gray-900 mb-4">Your AI-Powered Hotel Concierge</h2>
          <p className="text-gray-500 mb-10 max-w-2xl mx-auto">
            Ren Spaces provides a seamless chat experience for hotel guests and streamlines request management for your staff.
          </p>

          <div className="grid md:grid-cols-2 gap-8">
            {/* Guest Section */}
            <div className="bg-slate-50 border border-slate-200 rounded-xl p-8 flex flex-col items-center">
              <h3 className="text-lg font-bold text-gray-900 mb-4">For Guests</h3>
              <p className="text-sm text-gray-500 leading-relaxed text-center">
                To access the guest concierge, please use the unique link or QR code provided by your hotel.
              </p>
            </div>

            {/* Admin Section */}
            <div className="bg-slate-50 border border-slate-200 rounded-xl p-8 flex flex-col items-center">
              <h3 className="text-lg font-bold text-gray-900 mb-4">For Hotel Administrators</h3>
              <p className="text-sm text-gray-500 leading-relaxed text-center mb-6">
                Ready to bring Ren Spaces to your hotel? Get started by creating your hotel profile.
              </p>
              
              <div className="flex flex-col gap-3 w-full max-w-xs">
                <a href="#/signup" className="w-full bg-indigo-600 hover:bg-indigo-700 text-white font-semibold py-2.5 px-4 rounded-lg transition-colors shadow-sm">
                  Onboard Your Hotel
                </a>
                <a href="#/login" className="text-indigo-600 hover:text-indigo-800 text-sm font-medium">
                  Already have an account? Log In
                </a>
              </div>
            </div>
          </div>

        </div>
      </main>
    </div>
  );
};
