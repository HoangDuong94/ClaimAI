// srv/tools/database-tools.js - Verbesserte Version
/**
 * Database Tools für den StammtischAI Agent
 * Moderne CDS-Syntax ohne deprecated APIs
 */

const cds = require('@sap/cds');

class DatabaseTools {
  
  constructor() {
    this.tools = {
      'get_stammtische': this.getStammtische.bind(this),
      'get_stammtisch_by_id': this.getStammtischById.bind(this),
      'search_stammtische': this.searchStammtische.bind(this),
      'get_praesentatoren': this.getPraesentatoren.bind(this),
      'get_teilnehmer': this.getTeilnehmer.bind(this),
      'get_stammtisch_statistics': this.getStammtischStatistics.bind(this),
      'get_upcoming_stammtische': this.getUpcomingStammtische.bind(this)
    };
  }

  /**
   * Hauptmethode: Führt ein Tool aus
   */
  async executeTool(toolName, parameters = {}) {
    console.log(`=== Executing Tool: ${toolName} ===`);
    console.log('Parameters:', parameters);

    if (!this.tools[toolName]) {
      throw new Error(`Tool '${toolName}' not found. Available tools: ${Object.keys(this.tools).join(', ')}`);
    }

    try {
      const result = await this.tools[toolName](parameters);
      console.log(`Tool ${toolName} executed successfully`);
      return {
        success: true,
        tool: toolName,
        data: result,
        message: `Tool ${toolName} executed successfully`
      };
    } catch (error) {
      console.error(`Error executing tool ${toolName}:`, error);
      return {
        success: false,
        tool: toolName,
        error: error.message,
        message: `Error executing tool ${toolName}: ${error.message}`
      };
    }
  }

  /**
   * Tool: Alle Stammtische abrufen
   */
  async getStammtische(params = {}) {
    const { limit = 10, offset = 0 } = params;
    
    const query = SELECT.from('sap.stammtisch.Stammtische')
      .columns(['ID', 'thema', 'datum', 'ort', 'notizen'])
      .limit(limit, offset)
      .orderBy('datum desc');

    const result = await cds.run(query);
    
    return {
      count: result.length,
      stammtische: result.map(s => ({
        id: s.ID,
        thema: s.thema,
        datum: s.datum,
        ort: s.ort,
        notizen: s.notizen ? s.notizen.substring(0, 100) + '...' : null
      }))
    };
  }

  /**
   * Tool: Einzelnen Stammtisch abrufen
   */
  async getStammtischById(params) {
    const { id } = params;
    
    if (!id) {
      throw new Error('Parameter "id" is required');
    }

    const query = SELECT.from('sap.stammtisch.Stammtische')
      .where({ ID: id })
      .columns(['ID', 'thema', 'datum', 'ort', 'notizen', 'praesentator_ID']);

    const result = await cds.run(query);

    if (!result || result.length === 0) {
      throw new Error(`Stammtisch with ID ${id} not found`);
    }

    const stammtisch = result[0];

    // Präsentator-Daten laden
    if (stammtisch.praesentator_ID) {
      const praesentatorQuery = SELECT.from('sap.stammtisch.Praesentatoren')
        .where({ ID: stammtisch.praesentator_ID })
        .columns(['name', 'email', 'linkedin']);
      
      const praesentator = await cds.run(praesentatorQuery);
      stammtisch.praesentator = praesentator[0] || null;
    }

    // Teilnehmer laden
    const teilnehmerQuery = SELECT.from('sap.stammtisch.Teilnehmer')
      .where({ stammtisch_ID: id })
      .columns(['ID', 'name', 'email']);
    
    const teilnehmer = await cds.run(teilnehmerQuery);
    stammtisch.teilnehmer = teilnehmer;

    return stammtisch;
  }

  /**
   * Tool: Stammtische suchen - SICHERE VERSION
   */
  async searchStammtische(params) {
    const { query: searchQuery, limit = 10 } = params;
    
    if (!searchQuery) {
      throw new Error('Parameter "query" is required');
    }

    console.log(`Searching for: "${searchQuery}"`);

    // Option 1: Sichere Parametrisierte Query
    try {
      // Verwende mehrere einzelne WHERE-Bedingungen mit OR
      const result = await cds.run(
        SELECT.from('sap.stammtisch.Stammtische')
          .columns(['ID', 'thema', 'datum', 'ort'])
          .where(
            { thema: { like: `%${searchQuery}%` } },
            'or',
            { ort: { like: `%${searchQuery}%` } },
            'or', 
            { notizen: { like: `%${searchQuery}%` } }
          )
          .limit(limit)
          .orderBy('datum desc')
      );

      console.log(`Search found ${result.length} results`);
      
      return {
        searchQuery,
        count: result.length,
        results: result
      };

    } catch (error) {
      console.warn('Parametrisierte Query fehlgeschlagen, versuche Alternative:', error.message);
      
      // Option 2: Alternative mit separaten Queries
      return await this.searchStammtischeAlternative(searchQuery, limit);
    }
  }

  /**
   * Alternative Such-Implementierung
   */
  async searchStammtischeAlternative(searchQuery, limit = 10) {
    console.log('Using alternative search method');
    
    try {
      // Alle Stammtische laden und client-seitig filtern
      const allStammtische = await cds.run(
        SELECT.from('sap.stammtisch.Stammtische')
          .columns(['ID', 'thema', 'datum', 'ort', 'notizen'])
          .orderBy('datum desc')
      );

      // Client-seitige Filterung
      const searchLower = searchQuery.toLowerCase();
      const filtered = allStammtische.filter(s => 
        (s.thema && s.thema.toLowerCase().includes(searchLower)) ||
        (s.ort && s.ort.toLowerCase().includes(searchLower)) ||
        (s.notizen && s.notizen.toLowerCase().includes(searchLower))
      ).slice(0, limit);

      console.log(`Alternative search found ${filtered.length} results`);

      return {
        searchQuery,
        count: filtered.length,
        results: filtered.map(s => ({
          ID: s.ID,
          thema: s.thema,
          datum: s.datum,
          ort: s.ort
        }))
      };

    } catch (error) {
      console.error('Alternative search failed:', error);
      throw new Error(`Search failed: ${error.message}`);
    }
  }

  /**
   * Tool: Alle Präsentatoren abrufen
   */
  async getPraesentatoren(params = {}) {
    const { limit = 20 } = params;
    
    const query = SELECT.from('sap.stammtisch.Praesentatoren')
      .columns(['ID', 'name', 'email', 'linkedin'])
      .limit(limit);

    const result = await cds.run(query);
    
    return {
      count: result.length,
      praesentatoren: result
    };
  }

  /**
   * Tool: Teilnehmer für einen Stammtisch abrufen
   */
  async getTeilnehmer(params) {
    const { stammtischId } = params;
    
    if (!stammtischId) {
      throw new Error('Parameter "stammtischId" is required');
    }

    const query = SELECT.from('sap.stammtisch.Teilnehmer')
      .where({ stammtisch_ID: stammtischId })
      .columns(['ID', 'name', 'email']);

    const result = await cds.run(query);
    
    return {
      stammtischId,
      count: result.length,
      teilnehmer: result
    };
  }

  /**
   * Tool: Statistiken abrufen
   */
  async getStammtischStatistics(params = {}) {
    try {
      // Gesamtanzahl Stammtische
      const totalStammtische = await cds.run(
        SELECT.one(['count(*) as total']).from('sap.stammtisch.Stammtische')
      );

      // Gesamtanzahl Teilnehmer
      const totalTeilnehmer = await cds.run(
        SELECT.one(['count(*) as total']).from('sap.stammtisch.Teilnehmer')
      );

      // Gesamtanzahl Präsentatoren
      const totalPraesentatoren = await cds.run(
        SELECT.one(['count(*) as total']).from('sap.stammtisch.Praesentatoren')
      );

      // Stammtische nach Ort - vereinfacht
      const stammtischeByOrt = await cds.run(
        SELECT(['ort', 'count(*) as anzahl'])
          .from('sap.stammtisch.Stammtische')
          .groupBy('ort')
          .orderBy('anzahl desc')
          .limit(10)
      );

      // Aktivste Präsentatoren - vereinfacht für bessere Kompatibilität
      let aktivePraesentatoren = [];
      try {
        aktivePraesentatoren = await cds.run(
          SELECT(['p.name', 'count(s.ID) as stammtische_count'])
            .from('sap.stammtisch.Praesentatoren as p')
            .join('sap.stammtisch.Stammtische as s').on('s.praesentator_ID = p.ID')
            .groupBy('p.ID', 'p.name')
            .orderBy('stammtische_count desc')
            .limit(5)
        );
      } catch (joinError) {
        console.warn('JOIN query failed, using alternative approach:', joinError.message);
        // Fallback: Lade alle Daten und berechne client-seitig
        aktivePraesentatoren = await this.calculateActivePresentersAlternative();
      }

      return {
        summary: {
          totalStammtische: totalStammtische.total || 0,
          totalTeilnehmer: totalTeilnehmer.total || 0,
          totalPraesentatoren: totalPraesentatoren.total || 0
        },
        stammtischeByOrt: stammtischeByOrt || [],
        aktivePraesentatoren: aktivePraesentatoren || []
      };

    } catch (error) {
      console.error('Statistics query failed:', error);
      throw new Error(`Failed to get statistics: ${error.message}`);
    }
  }

  /**
   * Alternative Berechnung für aktivste Präsentatoren
   */
  async calculateActivePresentersAlternative() {
    try {
      const praesentatoren = await cds.run(
        SELECT.from('sap.stammtisch.Praesentatoren').columns(['ID', 'name'])
      );
      
      const stammtische = await cds.run(
        SELECT.from('sap.stammtisch.Stammtische').columns(['praesentator_ID'])
      );

      // Client-seitige Aggregation
      const counts = {};
      stammtische.forEach(s => {
        if (s.praesentator_ID) {
          counts[s.praesentator_ID] = (counts[s.praesentator_ID] || 0) + 1;
        }
      });

      // Top 5 aktivste Präsentatoren
      const result = praesentatoren
        .map(p => ({
          name: p.name,
          stammtische_count: counts[p.ID] || 0
        }))
        .filter(p => p.stammtische_count > 0)
        .sort((a, b) => b.stammtische_count - a.stammtische_count)
        .slice(0, 5);

      console.log('Alternative presenter calculation successful');
      return result;

    } catch (error) {
      console.error('Alternative presenter calculation failed:', error);
      return [];
    }
  }

  /**
   * Tool: Kommende Stammtische abrufen
   */
  async getUpcomingStammtische(params = {}) {
    const { limit = 5 } = params;
    const now = new Date().toISOString();

    try {
      const query = SELECT.from('sap.stammtisch.Stammtische')
        .where({ datum: { '>=': now } })
        .columns(['ID', 'thema', 'datum', 'ort'])
        .orderBy('datum asc')
        .limit(limit);

      const result = await cds.run(query);
      
      return {
        count: result.length,
        upcomingStammtische: result
      };

    } catch (error) {
      console.warn('Date query failed, using alternative approach:', error.message);
      
      // Alternative: Alle Stammtische laden und client-seitig filtern
      const allStammtische = await cds.run(
        SELECT.from('sap.stammtisch.Stammtische')
          .columns(['ID', 'thema', 'datum', 'ort'])
          .orderBy('datum asc')
      );

      const upcoming = allStammtische
        .filter(s => s.datum && new Date(s.datum) >= new Date())
        .slice(0, limit);

      return {
        count: upcoming.length,
        upcomingStammtische: upcoming
      };
    }
  }

  /**
   * Gibt verfügbare Tools zurück
   */
  getAvailableTools() {
    return {
      'get_stammtische': {
        description: 'Ruft alle Stammtische ab',
        parameters: {
          limit: 'Anzahl der Ergebnisse (optional, default: 10)',
          offset: 'Offset für Paginierung (optional, default: 0)'
        }
      },
      'get_stammtisch_by_id': {
        description: 'Ruft einen spezifischen Stammtisch mit Details ab',
        parameters: {
          id: 'UUID des Stammtisches (erforderlich)'
        }
      },
      'search_stammtische': {
        description: 'Sucht nach Stammtischen basierend auf Suchbegriff',
        parameters: {
          query: 'Suchbegriff (erforderlich)',
          limit: 'Anzahl der Ergebnisse (optional, default: 10)'
        }
      },
      'get_praesentatoren': {
        description: 'Ruft alle Präsentatoren ab',
        parameters: {
          limit: 'Anzahl der Ergebnisse (optional, default: 20)'
        }
      },
      'get_teilnehmer': {
        description: 'Ruft Teilnehmer für einen Stammtisch ab',
        parameters: {
          stammtischId: 'UUID des Stammtisches (erforderlich)'
        }
      },
      'get_stammtisch_statistics': {
        description: 'Ruft Statistiken über alle Stammtische ab',
        parameters: {}
      },
      'get_upcoming_stammtische': {
        description: 'Ruft kommende Stammtische ab',
        parameters: {
          limit: 'Anzahl der Ergebnisse (optional, default: 5)'
        }
      }
    };
  }
}

module.exports = DatabaseTools;